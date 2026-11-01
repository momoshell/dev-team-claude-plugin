import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { projectRecording, filterTrace, traceOverview, prettyTraceValue } from '../visualizer/web/src/lib/trajectory.js'
const recording = rows => ({file:'task/lean/builder/demo.builder.1.jsonl',raw:rows.map(row=>JSON.stringify(row)).join('\n')})
const frame = (kind, values = {}, sessionId = 's1', extra = {}) => ({sessionId,update:{sessionUpdate:kind,...values},...extra})

test('tool call lifecycle retains sparse payload/result and line identity without fabricating timing', () => {
  // MUTATION: remove call-ID aggregation or overwrite absent fields with null.
  const input=recording([
    {type:'prompt',text:'Repair the failing test'},
    frame('tool_call',{toolCallId:'c1',name:'Bash',status:'pending',rawInput:{}}),
    frame('tool_call_update',{toolCallId:'c1',rawInput:{command:'npm test'}}),
    frame('agent_message_chunk',{messageId:'m1',content:{type:'text',text:'Checking '}}),
    frame('tool_call_update',{toolCallId:'c1',status:'completed',rawOutput:{stdout:'hidden-output-needle',exit:0}}),
    frame('agent_message_chunk',{messageId:'m1',content:{type:'text',text:'the result.'}}),
    {type:'turn',stopReason:'end_turn',usage:{inputTokens:10,outputTokens:2},refusal:null},
  ])
  const copy=structuredClone(input), result=projectRecording(input), tool=result.records[1]
  assert.equal(result.tool_count,1); assert.equal(result.records.length,4)
  assert.deepEqual(tool.input,{command:'npm test'});assert.deepEqual(tool.output,{stdout:'hidden-output-needle',exit:0})
  assert.equal(tool.status,'completed');assert.equal(tool.incomplete,false);assert.deepEqual(tool.raw.map(r=>r.line),[2,3,5])
  assert.deepEqual([tool.started_at,tool.ended_at,tool.duration_ms],[null,null,null])
  assert.equal(result.records[2].output,'Checking the result.');assert.deepEqual(result.records[2].raw.map(r=>r.line),[4,6])
  assert.deepEqual(result.usage,{inputTokens:10,outputTokens:2});assert.deepEqual(result.records[3].usage,result.usage)
  assert.deepEqual(filterTrace(result.records,{query:'HIDDEN-OUTPUT-NEEDLE'}).map(r=>r.id),[tool.id])
  assert.deepEqual(input,copy)
})

test('call identity is isolated by recording and session; unidentified updates never coalesce', () => {
  // MUTATION: use callId alone as the map key.
  const input=recording([
    frame('tool_call_update',{toolCallId:'same',rawInput:{path:'first'}}),
    frame('tool_call',{toolCallId:'same',name:'read'}),
    frame('tool_call',{toolCallId:'same',name:'write'},'other-session'),
    frame('tool_call_update',{toolCallId:'same',rawOutput:'second output'},'other-session'),
    frame('tool_call_update',{rawOutput:'orphan one'}),frame('tool_call_update',{rawOutput:'orphan two'}),
  ])
  const result=projectRecording(input)
  assert.equal(result.tool_count,4);assert.equal(new Set(result.records.map(r=>r.id)).size,4)
  assert.deepEqual(result.records[0].input,{path:'first'});assert.equal(result.records[0].output,undefined)
  assert.equal(result.records[1].output,'second output');assert.equal(result.records[2].call_id,null)
  const retry=projectRecording({...input,file:'task/lean/builder/demo.builder.1.retry-1.jsonl'})
  assert.notEqual(retry.records[0].id,result.records[0].id)
  const appended=projectRecording({...input,raw:input.raw+'\n'+JSON.stringify(frame('tool_call_update',{toolCallId:'same',status:'failed'}))})
  assert.deepEqual(appended.records.map(r=>r.id),result.records.map(r=>r.id))
})

test('consecutive unkeyed chunks join only within the same stream, and source content stays inert text', () => {
  const input=recording([
    frame('agent_message_chunk',{content:{type:'text',text:'<script>alert(1)</script>'}}),
    frame('agent_message_chunk',{content:{type:'text',text:'literal'}}),
    frame('agent_thought_chunk',{content:{type:'text',text:'recorded reasoning'}}),
    frame('agent_message_chunk',{content:{type:'text',text:'new message'}}),
    frame('agent_message_chunk',{content:{type:'text',text:'other session'}},'s2'),
    frame('user_message_chunk',{content:{type:'text',text:'user input'}}),
  ])
  const result=projectRecording(input)
  assert.equal(result.records.length,5);assert.equal(result.records[0].output,'<script>alert(1)</script>literal')
  assert.equal(result.records[1].name,'Reasoning');assert.equal(result.records[4].kind,'input')
})

test('recorded terminal output wins over content; Claude and generic ACP result shapes remain inspectable', () => {
  const input=recording([
    frame('tool_call',{toolCallId:'c',kind:'execute',status:'in_progress'}),
    frame('tool_call_update',{toolCallId:'c',_meta:{claudeCode:{toolName:'Bash',toolResponse:{stdout:'claude output'}}}}),
    frame('tool_call_update',{toolCallId:'c',status:'completed'}),
    frame('tool_call',{toolCallId:'d',content:[{type:'content',content:{type:'text',text:'generic result'}}],status:'completed'}),
    frame('tool_call',{toolCallId:'e',rawOutput:null,content:[{text:'not the raw output'}]}),
  ])
  const result=projectRecording(input)
  assert.equal(result.records[0].name,'Bash');assert.deepEqual(result.records[0].output,{stdout:'claude output'})
  assert.match(result.records[1].preview,/generic result/);assert.equal(result.records[2].output,null)
  assert.equal(result.records[2].incomplete,true);assert.equal(prettyTraceValue(undefined),'Not recorded');assert.equal(prettyTraceValue(''),'')
})

test('explicit row timing is validated without borrowing metadata timestamps or the wall clock', () => {
  const start=1700000000000
  const input=recording([
    frame('tool_call',{toolCallId:'a' },'s',{at:start}),
    frame('tool_call_update',{toolCallId:'a',status:'completed'},'s',{at:start+123}),
    frame('tool_call',{toolCallId:'b'},'s',{at:start}),
    frame('tool_call_update',{toolCallId:'b',status:'failed'},'s',{at:start-1}),
    frame('tool_call',{toolCallId:'c',updatedAt:new Date(start).toISOString()},'s',{at:'invalid'}),
    frame('tool_call_update',{toolCallId:'c',status:'completed'},'s',{at:1e30}),
  ])
  const result=projectRecording(input)
  assert.equal(result.records[0].duration_ms,123);assert.equal(result.records[1].duration_ms,null)
  assert.deepEqual([result.records[2].started_at,result.records[2].ended_at,result.records[2].duration_ms],[null,null,null])
})

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
