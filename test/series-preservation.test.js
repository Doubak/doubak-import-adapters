import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {scan} from '../src/scan.js';
import {convert} from '../src/convert.js';
test('legacy importer preserves embedded series bytes without synthesizing members or captures',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'doubak-import-series-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'input/items'),{recursive:true});
  const filename='20230127.1406_movie_4099277.html';
  const old=readFileSync(new URL(`./fixtures/its-my-data/collector/items/${filename}`,import.meta.url),'utf8');
  const body=Buffer.from(old+'\n<script>var _CONFIG = '+JSON.stringify({SUBJECT_ID:'4099277',SERIES_SEASON_NAMES:{},
    SERIES_OTHER_SUBJECTS:[{id:'999',title:'Related only',url:'https://movie.douban.com/subject/999/'}],
    SERIES:{series_url:'https://movie.douban.com/series/ABC',series_total:'2'}})+';</script>');
  writeFileSync(join(dir,'input/items',filename),body);
  const {entries}=scan(join(dir,'input'));
  const bundles=await convert({entries,outDir:join(dir,'output'),account:{userId:'111',username:'example',notes:[]},timezone:'Asia/Shanghai'});
  assert.equal(bundles.length,1);
  const b=bundles[0], rows=readFileSync(join(b.dir,b.manifest.index.filename),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,1);assert.equal(rows[0].intent,'interest.item');assert.equal(rows[0].verdict,'soft404','Adding a config must not promote this real failed page to content');
  assert.equal(rows[0].capture_fidelity,'decoded_body+synthesized_headers');
  const segment=readFileSync(join(b.dir,rows[0].segment));
  const raw=gunzipSync(segment.subarray(rows[0].offset,rows[0].offset+rows[0].length));
  const http=raw.indexOf('\r\n\r\n')+4, payload=raw.indexOf('\r\n\r\n',http)+4;
  assert.deepEqual(raw.subarray(payload,payload+body.length),body);
  assert.equal(rows[0].series,undefined);
});
