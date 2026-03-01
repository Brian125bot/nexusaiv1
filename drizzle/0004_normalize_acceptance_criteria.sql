UPDATE "goals"
SET "acceptance_criteria" = (
  SELECT jsonb_agg(
    CASE 
      WHEN jsonb_typeof(elem) = 'string' THEN 
        jsonb_build_object(
          'id', gen_random_uuid(),
          'text', elem,
          'met', false,
          'reasoning', null,
          'files', '[]'::jsonb
        )
      WHEN jsonb_typeof(elem) = 'object' THEN
        jsonb_build_object(
          'id', COALESCE(elem->>'id', gen_random_uuid()::text),
          'text', elem->>'text',
          'met', COALESCE((elem->>'met')::boolean, false),
          'reasoning', COALESCE(elem->>'reasoning', null),
          'files', COALESCE(elem->'files', '[]'::jsonb)
        )
      ELSE elem
    END
  )
  FROM jsonb_array_elements("acceptance_criteria") AS elem
)
WHERE jsonb_typeof("acceptance_criteria") = 'array' 
AND jsonb_array_length("acceptance_criteria") > 0;
