// Minimal fast-xml-parser stub for the retirement probe bundle. The retirement path
// never parses XML; this only satisfies the module graph without pulling optional deps.
export class XMLParser { parse() { throw new Error('xml_unavailable_in_probe'); } }
export const XMLValidator = { validate() { return false; } };
