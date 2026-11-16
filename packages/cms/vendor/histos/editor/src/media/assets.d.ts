// Vite's `?url` imports: the URL of a file the build emits next to the script.
declare module '*?url' {
  const url: string;
  export default url;
}
