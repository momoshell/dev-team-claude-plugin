// Only scalar model preferences use the picker. Other native shapes stay opaque.
export function modelPreference(metadata = '') {
  const lines=metadata.split('\n'), matches=lines.map((line,index)=>({line,index})).filter(({line})=>/^model\s*:/.test(line))
  if(!matches.length) return {value:'',editable:true}
  if(matches.length!==1) return {value:'',editable:false}
  const {line,index}=matches[0], raw=line.slice(line.indexOf(':')+1).trim()
  if(!raw || /^(?:[>|{\[&*]|null$|~$)/.test(raw) || /^\s+\S/.test(lines[index+1] || '')) return {value:raw,editable:false}
  if(raw.startsWith('"')) {try {const value=JSON.parse(raw);return {value,editable:typeof value==='string'}} catch {return {value:raw,editable:false}}}
  if(raw.startsWith("'")) return raw.endsWith("'") ? {value:raw.slice(1,-1).replaceAll("''","'"),editable:true} : {value:raw,editable:false}
  if(raw.includes(' #')) return {value:raw,editable:false}
  return {value:raw,editable:true}
}
export function configuredModels(payload) {
  return [...new Map((Array.isArray(payload?.models)?payload.models:[])
    .filter(row=>typeof row.provider==='string' && row.provider && typeof row.id==='string' && row.id)
    .map(row=>[`${row.provider}/${row.id}`,{key:`${row.provider}/${row.id}`,provider:row.provider,id:row.id}])).values()]
    .sort((a,b)=>a.key.localeCompare(b.key))
}
export function setModelPreference(metadata,value,models) {
  if(!modelPreference(metadata).editable) throw new Error('This file uses a complex model setting. Keep it in Additional frontmatter.')
  if(value!=='' && !models.some(model=>model.key===value)) throw new Error('Choose a model from the configured roster.')
  const lines=metadata.split('\n'), index=lines.findIndex(line=>/^model\s*:/.test(line))
  if(index>=0) { if(value==='') lines.splice(index,1); else lines[index]=`model: ${JSON.stringify(value)}` }
  else if(value) lines.push(`model: ${JSON.stringify(value)}`)
  return lines.join('\n').replace(/^\n/,'')
}
export const transportLabel = value => ({pane:'Visible terminal', 'headless-json':'Background · JSON', 'headless-rpc':'Background · RPC', acp:'Agent Client Protocol (ACP)'})[value] || value
export const capabilityLabel = value => ({extensions:'Extensions',skills:'Skills',mcp_servers:'MCP servers',local_provider:'Local model providers'})[value] || value
