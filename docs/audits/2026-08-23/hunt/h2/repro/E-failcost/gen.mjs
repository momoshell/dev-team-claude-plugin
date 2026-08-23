import { test } from 'node:test'
import assert from 'node:assert'
const N = Number(process.env.N || 50)
for (let i = 0; i < N; i++) {
  test(`deep equal mismatch ${i}`, () => {
    assert.deepStrictEqual(
      { id: i, rows: Array.from({length:12},(_,k)=>({k, name:`row-${k}`, ok:true})) },
      { id: i, rows: Array.from({length:12},(_,k)=>({k, name:`row-${k}`, ok:false})) },
    )
  })
}
