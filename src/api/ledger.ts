import type { FastifyPluginAsync } from "fastify";

const ledgerEntries = [
  {
    id: "entry-1",
    kind: "credit",
    amount: 100,
    currency: "LSP",
    createdAt: new Date().toISOString()
  }
];

const ledgerRoutes: FastifyPluginAsync = async (app) => {
  app.get("/ledger", async () => {
    return { data: ledgerEntries };
  });
};

export default ledgerRoutes;
