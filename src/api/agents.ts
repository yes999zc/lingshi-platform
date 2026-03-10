import type { FastifyPluginAsync } from "fastify";

const agents = [
  {
    id: "agent-1",
    name: "Coordinator",
    status: "idle"
  }
];

const agentsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/agents", async () => {
    return { data: agents };
  });

  app.get("/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = agents.find((item) => item.id === id);

    if (!agent) {
      return reply.code(404).send({ error: "Agent not found" });
    }

    return { data: agent };
  });
};

export default agentsRoutes;
