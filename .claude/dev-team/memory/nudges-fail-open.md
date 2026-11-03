---
name: nudges-fail-open
description: A refuse-and-redirect arm fails open: act only on a certain match
metadata:
  type: feedback
---

A refuse-and-redirect arm acts on a certain match and does nothing when unsure. The live case is readgate (`crew/pi/extensions/readgate.ts`), which refuses a Bash grep and redirects it toward fff. A false positive blocks or misleads a legitimate call and is a defect. A miss in an uncommon shell form is accepted. Name the measured common forms that must be caught.
