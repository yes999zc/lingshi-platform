declare module "@fastify/static" {
  import { FastifyPluginAsync } from 'fastify';
  
  interface FastifyStaticOptions {
    root: string;
    prefix?: string;
    decorateReply?: boolean;
    // 其他选项可以按需添加
  }
  
  const fastifyStatic: FastifyPluginAsync<FastifyStaticOptions>;
  export default fastifyStatic;
}