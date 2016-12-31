// goal: existing addons can just drop this in and not change their packet format.
// should work for webextensions, sdk, and restartless addons.
//
// const metrics = new Metrics({id: '@min-vid'}); // experiment without GA
// const metrics = new Metrics({id: '@min-vid', tid: xxx, cid: xxx}); // SDK experiment with GA
// const metrics = new Metrics({id: 'testpilot@mozilla', tid: xxx, cid: xxx, topic: 'testpilot'}); // testpilot itself
//
// TODO: document usage
// TODO: why not just use ES6 modules?

// Abstract the sendBeacon DOM API, since sketchy hidden window magic is
// needed to get the reference, if the addon is not a WebExtension.
let _sendBeacon;

class Metrics {

  // Required keys in the config object:
  //   tid: GA tid. required to use GA.
  //   cid: GA cid. required to use GA.
  //   id: the addon's ID (like '@min-vid'). While FF now supports WebExtensions
  //       without an explicit ID, because TxP experiments aren't hosted on AMO,
  //       an ID is needed to sign them anyway.
  //
  // Optional keys in the config object:
  //   transform: a function used to modify GA pings before sending them. The
  //   default is to always use the 'event' GA ping type, but if experiment
  //   authors want to use different events for different situations, then
  //   passing in a transform function allows for that. The transform is called
  //   with no `this` value, so it should be bound before it is passed in. Also,
  //   its positional arguments are, in order: the metrics instance, then the
  //   arguments passed to sendEvent: event, object, category, study, variant.
  //   The metrics instance is passed first so that the tid, cid, and addon ID
  //   can be obtained from it, rather than having to bind those values inside
  //   the transform itself.
  //
  //   topic: 'testpilottest' by default. Experiments should not need to change
  //          this value. It's only changed by the Test Pilot addon.
  //
  //   debug: false by default; if true, this module will console.log info that
  //          is useful for debugging. Note that this value can be changed after
  //          the object is instantiated: set  `metrics.debug = true` in a paused
  //          debugger to see what is or isn't happening.
  constructor(opts) {
    // Note: the console must be initialized first, since other init steps log to
    // console in debug mode.
    this._initConsole();
    this._initValues(opts);
    this._initTransports();

    this.sendEvent = this.sendEvent.bind(this);
  }

  /* public API */

  // The sendEvent method forwards pings to Google Analytics, if configured.
  // It also tries to send pings to Telemetry and Ping Centre, discarding
  // any errors encountered. The Telemetry and Ping Centre endpoints will
  // generally only work while the add-on is an active Test Pilot experiment.
  //
  // Parameters:
  // * `event`: What is happening?  eg. `click`
  // * `object`: What is being affected?  eg. `home-button-1`
  // * `category` (optional): If you want to add a category for easy reporting
  //   later. eg. `mainmenu`
  //
  // The final two optional parameters are used together to capture information
  // about multivariate or A/B tests that an experiment might be running.
  //
  // * `study` (optional): String ID for a given test, eg. `button-test`. Note
  //   that Google Analytics truncates this field past a 40 byte limit, or, 40
  //   non-entity ascii characters encoded as UTF-8. TODO make sure this is accurate. / reword the warning.
  // * `variant` (optional): An identifying string if you're running different
  //   variants. eg. `red-button` or `green-button`.
  //
  // TODO: would it be useful to version this API beyond this package's semver number?
  //       come up with three good examples/reasons, or give up the idea.
  sendEvent(event, object, category, study, variant) {
    if (!event) {
      throw new Error(`event field must be passed to sendEvent`);
    }
    if (!object) {
      throw new Error(`object field must be passed to sendEvent`);
    }

    if (this.tid && this.cid) {
      this._sendGA(event, object, category, study, variant);
    }

    this._sendClientPing(msg);
  }

  /* private API */

  // Ensure console is present. Only required for bootstrapped addons.
  _initConsole() {
    try {
      Components.utils.import('resource://gre/modules/Services.jsm');
    } catch (ex) {} // Ignore the error for SDK or WebExtensions.
  }

  // Ensure required parameters are present and assign them.
  _initValues(opts) {
    const {id, tid, cid, topic, debug, transform} = opts;

    this.debug = !!debug;
    this._log(`_initValues: debug set to true; verbose debug logging enabled.`);

    if (!id) {
      throw new Error('id is required.');
    } 
    this.id = id;
    this._log(`_initValues: Initialized this.id to ${id}.`);

    if (tid && !cid) {
      throw new Error('Both tid and cid are required for Google Analytics to work. cid not provided.');
    } else if (!tid && cid) {
      throw new Error('Both tid and cid are required for Google Analytics to work. tid not provided.');
    }
    this._log(`_initValues: Initialized this.tid to ${tid} and this.cid to ${cid}.`);
    this.tid = tid;
    this.cid = cid;

    if (transform && typeof transform === 'function') {
      this.transform = transform;
      this._log(`_initValues: Initialized this.transform to a function.`);
    } else {
      this.transform = null;
      this._log(`_initValues: Initialized this.transform to null.`);
    }

    // Experiment authors should just use the default 'testpilottest' topic.
    // `topic` is only configurable so that the Test Pilot addon can submit its
    // own pings using this same library.
    this.topic = topic || 'testpilottest';
    this._log(`_initValues: Initialized this.topic to ${this.topic}.);
  }

  // Load transports needed for Telemetry and GA submissions, and infer the
  // addon's type based on which approach works.
  _initTransports() {
    // The Telemetry transport is either the BroadcastChannel DOM API (for 
    // WebExtensions), or the nsIObserverService (for SDK and bootstrapped
    // addons).
    //
    // The GA transport is the navigator.sendBeacon DOM API. In the case of 
    // SDK and bootstrapped addons, there might not be a DOM window available,
    // so get the reference from the hidden window. 
    try {
      // First, try the SDK approach.
      const { Cu } = require('chrome');
      Cu.import('resource://gre/modules/Services.jsm');
      _sendBeacon = Services.appShell.hiddenDOMWindow.navigator.sendBeacon;
      this.type = 'sdk';
      this._log('Initialized SDK addon transports.');
    } catch(ex) {
      // Next, try the bootstrapped approach.
      try {
        Components.utils.import('resource://gre/modules/Services.jsm');
        _sendBeacon = Services.appShell.hiddenDOMWindow.navigator.sendBeacon;
        this.type = 'bootstrapped';
        this._log('Initialized bootstrapped addon transports.');
      } catch(ex) {
        // Finally, try the WebExtension approach.
        try {
          this._channel = new BroadcastChannel(this.topic);
          _sendBeacon = navigator.sendBeacon; // TODO: will this always be visible to webextensions?
          this.type = 'webextension';
          this._log('Initialized WebExtension addon transports.');
        } catch (ex) {
          // If all three approaches fail, give up.
          throw new Error('Unable to initialize transports: ', ex);
        }
      }
    }
  }

  // Log to console when in debug mode. Debug mode is triggered by adding
  // `debug: true` to the config object passed to the constructor, or, by
  // setting `metrics.debug` to true, where `metrics` is a running instance
  // of this class.
  _log(str) {
    if (this.debug) {
      console.log(str);
    }
  }

  // Send a ping to the Test Pilot add-on, to be forwarded to the Mozilla
  // Telemetry and Ping Centre services.
  _sendClientPing(event, object, category, study, variant) {
    // Construct and serialize the payload using the Telemetry format.
    const data = {
      event: event,
      object: object
    };

    if (category) {
      data.category = category;
    }

    if (study && variant) {
      data.study = study;
      data.variant = variant;
    }
    this._log(`Data object created: ${data}`);

    let msg;

    try {
      msg = JSON.stringify(data);
    } catch(ex) {
      throw new Error(`Unable to serialize metrics event: ${ex}`);
    }
    this._log(`Data object stringified: ${msg}`);

    if (this.type === 'webextension') {
      try {
        this._channel.postMessage(msg); // TODO: is msg the right format?
        this._log(`Sent client ping via postMessage: ${msg}`);
      } catch (ex) {
        this._log(`Failed to send client ping via postMessage: ${ex}`);
      }
    } else { /* type is 'sdk' or 'bootstrapped' */
      const subject = {
        wrappedJSObject: {
          observersModuleSubjectWrapper: true,
          object: this.id
        }
      };

      try {
        Services.obs.notifyObservers(subject, 'testpilot::send-metric', msg);
        this._log(`Sent client ping via notifyObservers: ${msg}`);
      } catch (ex) {
        this._log(`Failed to send client ping via notifyObservers: ${ex}`);
      }
    }
  }

  // Send a ping to Google Analytics.
  _sendGA(event, object, category, study, variant) {
    if (!this.tid && !this.cid) {
      return this._log(`Unable to send metrics event to GA, because 'tid' and 'cid' are missing.`);
    } else if (!this.tid) {
      return this._log(`Unable to send metrics event to GA, because 'tid' is missing.`);
    } else if (!this.cid) {
      return this._log(`Unable to send metrics event to GA, because 'cid' is missing.`);
    }

    if ((study && !variant) || (!study && variant)) {
      this._log(`Warning: 'study' and 'variant' must both be present to be recorded by Google Analytics.`);
    }

    // For field descriptions, see https://developers.google.com/analytics/devguides/collection/protocol/v1/ 
    let data;
    if (this.transform) {
      data = this.transform.call(null, this, event, object, category, study, variant);
      this._log(`Data object created by user-supplied transform: ${data}`);
    } else {
      data = {
        v: 1,
        tid: this.tid,
        cid: this.cid,
        t: 'event',
        ec: category || 'add-on Interactions', // TODO: is this a good default category? category is required, so something's needed here.
        ea: object,
        el: event
      };

      // Send the optional multivariate testing info, if it was included.
      if (study && variant) {
        data.xid = study;
        data.xval = variant;
      }
      this._log(`Data object created: ${data}`);
    }

    const serialized = this._serialize(data);
    _sendBeacon('https://ssl.google-analytics.com/collect', serialized);
  }

  // Serialize an object into x-www-form-urlencoded format.
  // Example: {a:'b', foo:'b ar'} => 'a=b&foo=b%20ar'
  _serialize(obj) {
    const params = [];
    Object.entries(obj).forEach(item => {
      const encoded = encodeURIComponent(item[0]) + '=' + encodeURIComponent(item[1]);
      params.push(encoded);
    });
    return params.join('&');
  }
}

module.exports = Metrics;
