export const ErrorMapper = {
  cache: {} as { sourceMap?: any },

  loadSourceMap(): void {
    if (!this.cache.sourceMap) {
      try {
        const rawMap = (RawMemory.get() as unknown as { [key: string]: string })['main.js.map'];
        this.cache.sourceMap = JSON.parse(rawMap); // Parse the source map JSON
      } catch (e) {
        console.log("Error loading source map:", e);
        this.cache.sourceMap = null;
      }
    }
  },

  getOriginalPosition(line: number, column: number): string | null {
    this.loadSourceMap();
    if (!this.cache.sourceMap) return null;

    const mappings = this.cache.sourceMap.mappings; // Now correctly accessing the parsed object

    for (const map of mappings) {
      if (map.generatedLine === line && map.generatedColumn === column) {
        return `${map.source}:${map.originalLine}:${map.originalColumn}`;
      }
    }
    return null;
  },

  parseStackTrace(stack: string): string {
    this.loadSourceMap();
    if (!this.cache.sourceMap) return stack; // If no source map, return the stack as is

    return stack
      .split("\n")
      .map((line) => {
        const match = line.match(/(\w+\.js):(\d+):(\d+)/); // Extract filename, line, and column
        if (!match) return line;

        const [, file, lineNumber, columnNumber] = match;
        const originalPosition = this.getOriginalPosition(Number(lineNumber), Number(columnNumber));
        return originalPosition ? line.replace(match[0], originalPosition) : line;
      })
      .join("\n");
  },

  wrapLoop<T extends Function>(fn: T): T {
    return ((...args: any[]) => {
      try {
        return fn(...args);
      } catch (e) {
        if (e instanceof Error) {
          console.log(`Error in loop: ${e.message}\n${this.parseStackTrace(e.stack || "")}`);
        } else {
          console.log(`Error in loop: ${e}`);
        }
      }
    }) as unknown as T;
  },
};
