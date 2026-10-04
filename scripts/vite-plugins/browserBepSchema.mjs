/** @returns {import("vite").Plugin} */
export const createBrowserBepSchemaPlugin = () => ({
  name: "syncpeer-browser-protocol-schema",
  enforce: "pre",
  transform(code, id) {
    if (!id.endsWith("/packages/core/src/core/protocol/bep.ts")) return null;
    const schemaLoader = /const loadSchemaText = async \(\): Promise<string> => \{[\s\S]*?\n};\n\nconst schemaText = await loadSchemaText\(\);\n/;
    if (!schemaLoader.test(code)) throw new Error("The browser BEP schema loader changed unexpectedly.");
    return code.replace(schemaLoader,
      'import schemaText from "../../../vendor/syncthing/proto/bep.proto?raw";\n');
  },
});
