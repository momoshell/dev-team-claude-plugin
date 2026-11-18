import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { projectRecording, filterTrace, traceOverview, prettyTraceValue } from '../visualizer/web/src/lib/trajectory.js'
const recording = rows => ({file:'task/lean/builder/demo.builder.1.jsonl',raw:rows.map(row=>JSON.stringify(row)).join('\n')})
const frame = (kind, values = {}, sessionId = 's1', extra = {}) => ({sessionId,update:{sessionUpdate:kind,...values},...extra})

test('broken rows and unsupported updates stay visible, usage snapshots never become turn totals', () => {
  const input=recording([
    null,[],42,{update:{sessionUpdate:'plan',entries:{broken:true}}},
    frame('usage_update',{used:100}),frame('usage_update',{used:200}),
    frame('future_update',{nested:{value:'preserved'}}),
    {kind:'permission',tool:'execute',option_kind:'reject_once',tool_call_id:'p'},
    {type:'turn',refusal:{message:'provider failed'},usage:null},
  ])
  input.raw += '\n{"truncated":\n'
  const result=projectRecording(input)
  assert.equal(result.records.length,10);assert.equal(result.warnings.length,4);assert.equal(result.usage,null)
  assert.equal(result.records[6].output.nested.value,'preserved');assert.match(result.records[7].text,/reject_once/)
  assert.equal(result.records[8].status,'refused');assert.equal(result.records[9].raw[0].line,10)
  assert.deepEqual(projectRecording().records,[]);assert.deepEqual(projectRecording({raw:' \n'}).records,[])
})

test('event filters and overview preserve source slots for a large trace and inclusive ranges', () => {
  // MUTATION: compute slots from filtered records or treat range endpoints as exclusive.
  const result=projectRecording(recording(Array.from({length:137},(_,i)=>frame('tool_call',{toolCallId:`c${i}`,name:'read',rawInput:{path:`file-${i}`}}))))
  const overview=traceOverview(result.records)
  assert.equal(overview.length,137);assert.equal(overview[136].index,137);assert.equal(overview[136].x,136/137)
  assert.equal(overview[0].width,1/137);assert.equal(overview[136].lane,'Tools')
  assert.deepEqual(filterTrace(result.records,{from:10,to:12}).map(r=>r.index),[10,11,12])
  assert.equal(filterTrace(result.records,{kind:'model'}).length,0);assert.equal(filterTrace(result.records,{query:'file-136'}).length,1)
  const source=readFileSync(new URL('../visualizer/web/src/lib/DeveloperTools.svelte',import.meta.url),'utf8')
  assert.match(source,/filtered\.slice\(\(currentPage - 1\) \* 50, currentPage \* 50\)/)
  assert.doesNotMatch(source,/{@html|eval\(/)
})

test('recorded Claude and Pi streams retain real tool payload/result formats', () => {
  // Recorded by the Wave 0 ACP probe; provenance/versions in test/fixtures/acp/README.md.
  // MUTATION: discard content/Claude rawOutput while preserving completion status.
  for(const name of ['claude-turn','pi-turn']) {
    const captured=readFileSync(new URL(`./fixtures/acp/${name}.ndjson`,import.meta.url),'utf8').trim().split('\n').map(JSON.parse)
    const rows=captured.filter(row=>row.frame?.method==='session/update').map(row=>row.frame.params)
    const result=projectRecording(recording(rows)), tools=result.records.filter(record=>record.kind==='tool')
    assert.equal(tools.length,1);assert.equal(tools[0].status,'completed');assert.equal(tools[0].duration_ms,null)
    assert.match(prettyTraceValue(tools[0].input),/RECORDED/)
    assert.match(prettyTraceValue(tools[0].output),name==='claude-turn'?/File created successfully/:/RECORDED/)
    assert.ok(result.records.some(record=>record.kind==='model'))
  }
})

test('recorded-time overview uses measured endpoints and omits unknown/reversed intervals', async () => {
  // MUTATION: include untimed records in a time domain, or project ordinal slots as time.
  const {nearestTraceSpan}=await import('../visualizer/web/src/lib/trajectory.js')
  const input=recording([
    {type:'prompt',text:'untimed'},
    frame('tool_call',{toolCallId:'first',name:'read'},'s',{at:1000}),
    frame('tool_call_update',{toolCallId:'first',status:'completed'},'s',{at:1200}),
    frame('agent_message_chunk',{content:{type:'text',text:'a'}},'s',{at:1300}),
    frame('agent_message_chunk',{content:{type:'text',text:'b'}},'s',{at:1400}),
    frame('tool_call',{toolCallId:'last'},'s',{at:1500}),
    frame('tool_call_update',{toolCallId:'last',status:'completed'},'s',{at:2000}),
    frame('tool_call',{toolCallId:'open'},'s',{at:2100}),
  ])
  const result=projectRecording(input), timed=traceOverview(result.records,'time')
  assert.deepEqual(timed.map(span=>[span.index,span.x,span.width]),[[2,0,.2],[3,.3,.1],[4,.5,.5]])
  assert.equal(nearestTraceSpan(timed,.15,'Tools').index,2)
  assert.equal(nearestTraceSpan(timed,.7,'Tools').index,4)
  assert.equal(nearestTraceSpan(timed,.35,'Model').index,3)
  assert.equal(nearestTraceSpan([],0,'Tools'),null)
  assert.deepEqual(traceOverview(projectRecording(recording([{type:'prompt',text:'old'}])).records,'time'),[])

  // A trace with no elapsed time must show points, never full-width duration bars.
  const simultaneous=projectRecording(recording([
    frame('user_message_chunk',{content:{text:'input'}},'s',{at:1000}),
    frame('agent_message_chunk',{content:{text:'reply'}},'s',{at:1000}),
  ]))
  assert.deepEqual(traceOverview(simultaneous.records,'time').map(span=>[span.x,span.width]),[[0,0],[0,0]])
})


test('malformed event labels remain inspectable without becoming non-text UI names', () => {
  // MUTATION: pass raw sessionUpdate/type/kind/title values through as display names.
  const result=projectRecording(recording([
    {type:{broken:true},kind:['bad']},
    {update:{sessionUpdate:{future:true}}},
    frame('tool_call',{toolCallId:'bad-title',title:['Bash']}),
  ]))
  assert.deepEqual(result.records.map(record=>record.name),['Unrecognized event','Unrecognized event','Tool name not recorded'])
  assert.deepEqual(result.records[0].raw[0].row.type,{broken:true})
  assert.deepEqual(result.records[1].output.sessionUpdate,{future:true})
  for(const record of result.records) assert.equal(typeof record.preview,'string')
})
