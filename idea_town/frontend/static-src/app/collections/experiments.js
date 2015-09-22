import Collection from 'ampersand-rest-collection';

import Experiment from '../models/experiment';

export default Collection.extend({
  model: Experiment,
  indexes: ['slug'],
  url: '/api/experiments',

  // Ampersand.sync doesn't seem to pass correct Accept headers by default.
  // This supposedly is fixed by https://github.com/AmpersandJS/ampersand-sync/pull/24
  // but still seems busted. Maybe the deps of the dependents haven't been
  // updated yet? TODO: investigate
  ajaxConfig: { headers: { "Accept": "application/json" }},

  // django-rest-framework returns the actual models under 'results'
  parse(response) {
    return response.results;
  }
});
