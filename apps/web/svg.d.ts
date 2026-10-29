// Bun imports an SVG `with { type: "text" }` as its markup.
declare module "*.svg" {
  const content: string;
  export default content;
}
