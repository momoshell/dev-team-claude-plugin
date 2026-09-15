# Workflow seat maps

One file per workflow, `<name>.json`: `{ shape, seats: { <stage>: { role, agent, provider, id, effort, skills, extensions } } }`.
A map binds each seat-bearing stage of an execution shape (`crew/variants.mjs`) to a seat, and boot enforces it when
`--workflow <name>` is passed (#1295, #1288 D7). The schema and the validator leaf land with the first map.
