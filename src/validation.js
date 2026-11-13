import {ProviderError} from './provider.js';

/** Cache compiled schemas; publish fields and rule names, never argument values. */
export function createToolValidator(Ajv) {
  const ajv = new Ajv({strict:false,allErrors:false,validateFormats:false});
  const validators = new Map();
  const validate = (schema,args) => {
    validate.errors = [];
    const key = JSON.stringify(schema);
    let validator = validators.get(key);
    if (!validator) {
      try {validator = ajv.compile(schema);} catch {
        throw new ProviderError('INVALID_TOOL_SCHEMA','Native tool schema could not be compiled; no argument values were logged');
      }
      if (validators.size >= 256) validators.clear();
      validators.set(key,validator);
    }
    const valid = validator(args) === true;
    if (!valid) validate.errors = (validator.errors??[]).slice(0,3).map(error=>({
      field:error.instancePath || '/',rule:error.keyword,
      ...(error.keyword === 'required' ? {requiredField:error.params.missingProperty} : {}),
      ...(error.keyword === 'type' ? {expectedType:error.params.type} : {}),
    }));
    return valid;
  };
  validate.errors=[];
  return validate;
}
