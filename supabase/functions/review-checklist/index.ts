import { createHandler } from './handler.mjs';
Deno.serve(createHandler(Deno.env.toObject()));
