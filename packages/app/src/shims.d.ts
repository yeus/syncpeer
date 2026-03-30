declare module "lz4js";

declare module "*.proto?raw" {
  const content: string;
  export default content;
}
