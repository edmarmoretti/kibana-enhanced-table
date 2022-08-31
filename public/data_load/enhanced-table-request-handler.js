/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import _ from 'lodash';
import { CourierRequestHandlerProvider as courierRequestHandlerProvider } from 'ui/vis/request_handlers/courier';
import { SearchSourceProvider } from 'ui/courier/search_source';
import { RequestAdapter, DataAdapter } from 'ui/inspector/adapters';
import chrome from 'ui/chrome';

const handleCourierRequest = courierRequestHandlerProvider().handler;

export async function enhancedTableRequestHandler ({
  partialRows,
  metricsAtAllLevels,
  visParams,
  timeRange,
  query,
  filters,
  inspectorAdapters,
  queryFilter,
  forceFetch,
  aggs
}) {

  const MAX_HITS_SIZE = 10000;

  const $injector = await chrome.dangerouslyGetActiveInjector();
  const Private = $injector.get('Private');
  const SearchSource = Private(SearchSourceProvider);

  // set hits size
  let searchSourceBody = {};
  let hitsSize = (visParams.hitsSize !== undefined ? Math.min(visParams.hitsSize, MAX_HITS_SIZE) : 0);
  searchSourceBody.size = hitsSize;

  // specific request params for "field columns"
  if (visParams.fieldColumns !== undefined) {
    if (!visParams.fieldColumns.some (fieldColumn => fieldColumn.field.name === '_source')) {
      searchSourceBody._source = visParams.fieldColumns.map(fieldColumn => fieldColumn.field.name);
    }
    searchSourceBody.docvalue_fields = visParams.fieldColumns.filter(fieldColumn => fieldColumn.field.readFromDocValues).map(fieldColumn => fieldColumn.field.name);
    const scriptFields = {};
    visParams.fieldColumns.filter(fieldColumn => fieldColumn.field.scripted).forEach(fieldColumn => {
      scriptFields[fieldColumn.field.name] = {
        script: {
          source: fieldColumn.field.script
        }
      };
    });
    searchSourceBody.script_fields = scriptFields;
  }

  // set search sort
  if (visParams.sortField !== undefined) {
    searchSourceBody.sort = [{
      [visParams.sortField.name]: {
        order: visParams.sortOrder
      }
    }];
    if (visParams.hitsSize !== undefined && visParams.hitsSize > MAX_HITS_SIZE) {
      searchSourceBody.sort.push({'_doc': {}});
    }
  }

  // add 'count' metric if there is no input column
  if (aggs.length === 0) {
    aggs.createAggConfig({
      id: '1',
      enabled: true,
      type: 'count',
      schema: 'metric',
      params: {}
    });
  }

  // prepare elasticsearch query elements
  const searchSource = new SearchSource(searchSourceBody);
  searchSource.setField('index', aggs.indexPattern);
  inspectorAdapters.requests = new RequestAdapter();
  inspectorAdapters.data = new DataAdapter();

  // execute elasticsearch query
  const request = {
    searchSource,
    aggs,
    timeRange,
    query,
    filters,
    forceFetch,
    metricsAtAllLevels,
    partialRows,
    inspectorAdapters,
    queryFilter
  };
  const response = await handleCourierRequest(request);

  // enrich elasticsearch response and return it
  response.totalHits = _.get(searchSource, 'finalResponse.hits.total', -1);
  response.aggs = aggs;

  // enrich response: hits
  if (visParams.fieldColumns !== undefined) {
    response.fieldColumns = visParams.fieldColumns;
    response.hits = _.get(searchSource, 'finalResponse.hits.hits', []);

    // continue requests until expected hits size is reached
    if (visParams.hitsSize !== undefined && visParams.hitsSize > MAX_HITS_SIZE && response.totalHits > MAX_HITS_SIZE) {
      let remainingSize = visParams.hitsSize;
      do {
        remainingSize -= hitsSize;
        const searchAfter = response.hits[response.hits.length - 1].sort;
        hitsSize = Math.min(remainingSize, MAX_HITS_SIZE);
        searchSource.setField('size', hitsSize);
        searchSource.setField('searchAfter', searchAfter);
        await handleCourierRequest(request);
        const nextResponseHits = _.get(searchSource, 'finalResponse.hits.hits', []);
        for (let i = 0; i < nextResponseHits.length; i++) {
          response.hits.push(nextResponseHits[i]);
        }
      } while (remainingSize > hitsSize);
    }
  }
  return response;
}
