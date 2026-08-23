const hex=(h)=>{h=h.replace('#','');if(h.length===3)h=[...h].map(c=>c+c).join('');return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255)}
const lin=(c)=>c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4
const L=(h)=>{const[r,g,b]=hex(h).map(lin);return 0.2126*r+0.7152*g+0.0722*b}
const ratio=(a,b)=>{const l1=L(a),l2=L(b);return ((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05))}
const grounds={'ink-ground #17171a':'#17171a','ink-panel #1e1e22':'#1e1e22','paper-ground #efece5':'#efece5','paper-panel #e7e3da':'#e7e3da'}
const fg={'status-ok #2f9e62':'#2f9e62','status-fail #c94f58':'#c94f58','status-running #c38b18':'#c38b18','status-skipped #77747d':'#77747d','serious #ec835a':'#ec835a','ink-text #eae8ee':'#eae8ee','ink-muted #9b99a3':'#9b99a3','paper-text #15140f':'#15140f','paper-muted #55534a':'#55534a','spot-dark #cba6f7':'#cba6f7','spot-light #8839ef':'#8839ef'}
const rows=[]
for(const[fn,fv]of Object.entries(fg))for(const[gn,gv]of Object.entries(grounds))rows.push([fn,gn,ratio(fv,gv).toFixed(2)])
for(const r of rows)console.log(r[2].padStart(6),' ',r[0].padEnd(22),'on',r[1])
const hex=(h)=>{h=h.replace('#','');if(h.length===3)h=[...h].map(c=>c+c).join('');return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255)}
const lin=(c)=>c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4
const L=(h)=>{const[r,g,b]=hex(h).map(lin);return 0.2126*r+0.7152*g+0.0722*b}
const R=(a,b)=>{const l1=L(a),l2=L(b);return ((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05)).toFixed(2)}
const light={planner:'#2a78d6',builder:'#eb6834',reviewer:'#1baf7a','tech-lead':'#eda100',lead:'#e87ba4',driver:'#4a3aa7'}
const dark={planner:'#3987e5',builder:'#d95926',reviewer:'#199e70','tech-lead':'#c98500',lead:'#d55181',driver:'#9085e9'}
console.log('#fff on LIGHT (paper) role blocks — PhaseGantt .block color:#fff')
for(const[k,v]of Object.entries(light))console.log('  ',R('#ffffff',v).padStart(6),k,v)
console.log('#fff on DARK (ink) role blocks')
for(const[k,v]of Object.entries(dark))console.log('  ',R('#ffffff',v).padStart(6),k,v)
console.log('lane-6 (--neutral) vs lane-7 (--muted): paper',R('#55534a','#55534a'),'ink',R('#9b99a3','#9b99a3'),'=> identical colour')
