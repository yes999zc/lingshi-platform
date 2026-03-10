import type { FastifyPluginAsync } from "fastify";

const tasks = [
  {
    id: "task-1",
    title: "Bootstrap MVP",
    status: "open",
    assigneeAgentId: "agent-1"
  }
];

const tasksRoutes: FastifyPluginAsync = async (app) => {
  app.get("/tasks", async () => {
    return { data: tasks };
  });

  app.get("/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = tasks.find((item) => item.id === id);

    if (!task) {
      return reply.code(404).send({ error: "Task not found" });
    }

    return { data: task };
  });
};

export default tasksRoutes;
