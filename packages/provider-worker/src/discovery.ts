/**
 * Coinbase's Bazaar discovery extension: what a paid route takes and returns, carried in the 402.
 *
 * Coinbase indexes a route into the Bazaar, the catalogue behind Agentic.Market, once its CDP
 * facilitator settles a payment for it and finds this extension on the payment. The shapes follow
 * the reference builders in `@x402/extensions`: a query declaration for GET, HEAD and DELETE, a
 * JSON body declaration for POST, PUT and PATCH, each with a sample (`info`) and its JSON Schema
 * (`schema`), and Coinbase's validator checks both field for field.
 */
export type Discovery = {
  /** What the call returns, in a sentence a buyer reads. 500 characters at most. */
  readonly description: string;
  /** A sample request: the query parameters on GET, HEAD and DELETE, the JSON body otherwise. */
  readonly input?: Readonly<Record<string, unknown>>;
  /** JSON Schema for that input, as `properties` and `required`. */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  /** A sample response body. Coinbase's validator requires one. */
  readonly output: unknown;
  /** JSON Schema for the response, as `properties` and `required`. */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /** A JPG, PNG, WebP or GIF the listing shows. Not SVG. */
  readonly iconUrl?: string;
};

export type BazaarExtension = {
  readonly bazaar: { readonly info: Record<string, unknown>; readonly schema: Record<string, unknown> };
};

const QUERY_METHODS = ['GET', 'HEAD', 'DELETE'] as const;
const BODY_METHODS = ['POST', 'PUT', 'PATCH'] as const;
export const MAX_DESCRIPTION = 500;

export function bazaarExtension(method: string, discovery: Discovery): BazaarExtension {
  const verb = method.toUpperCase();
  const body = (BODY_METHODS as readonly string[]).includes(verb);
  const input = discovery.input ?? {};
  const inputSchema = { type: 'object', ...(discovery.inputSchema ?? { properties: {} }) };

  const info = {
    input: body ? { type: 'http', method: verb, bodyType: 'json', body: input } : { type: 'http', method: verb, queryParams: input },
    output: { type: 'json', example: discovery.output },
  };

  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      input: {
        type: 'object',
        properties: body
          ? {
              type: { type: 'string', const: 'http' },
              method: { type: 'string', enum: BODY_METHODS },
              bodyType: { type: 'string', enum: ['json', 'form-data', 'text'] },
              body: inputSchema,
            }
          : {
              type: { type: 'string', const: 'http' },
              method: { type: 'string', enum: QUERY_METHODS },
              queryParams: inputSchema,
            },
        required: body ? ['type', 'method', 'bodyType', 'body'] : ['type', 'method'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { type: { type: 'string' }, example: { type: 'object', ...(discovery.outputSchema ?? {}) } },
        required: ['type'],
      },
    },
    required: ['input'],
  };

  return { bazaar: { info, schema } };
}
