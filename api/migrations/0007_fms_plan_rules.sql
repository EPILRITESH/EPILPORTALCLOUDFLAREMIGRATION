-- 0007 — FMS: Excel-style planning and calculated columns.
--   fms_steps.plan        {"rules":[{"when":[cond…],"base":"previous|start|created|activated|step:N:actual|step:N:planned|field:key",
--                          "offset":1,"unit":"working_days|working_hours|days|hours|minutes","at_time":"18:00","formula":"…"}]}
--                         first matching rule plans the step; none → the step's TAT
--   fms_steps.depends_on  JSON list of step positions that must be finished before this step starts
--                         ('' = the previous step; '[]' = starts with the row, in parallel)
--   fms_fields.formula    calculated column / step input (Excel-like formula, recomputed on every change)
ALTER TABLE fms_steps ADD COLUMN plan TEXT NOT NULL DEFAULT '{}';
ALTER TABLE fms_steps ADD COLUMN depends_on TEXT NOT NULL DEFAULT '';
ALTER TABLE fms_fields ADD COLUMN formula TEXT NOT NULL DEFAULT '';
