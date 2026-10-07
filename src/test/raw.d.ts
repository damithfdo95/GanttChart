interface ImportMeta {
  glob<T = unknown>(pattern: string | string[], options?: { query?: string; import?: string; eager?: boolean }): Record<string, T>;
}

declare module '*?raw' {
  const text: string;
  export default text;
}
