// The server's policy forbids evaluating strings as code (ADR 0010). Zod's
// compiled parsers probe for that as each schema is built, and the browser
// reports the probe as a violation even though Zod catches it. So the console
// parses without them, set before any module that builds a schema is loaded.
import { z } from 'zod';

z.config({ jitless: true });
