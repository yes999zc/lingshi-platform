import type Database from "better-sqlite3";

export interface BidRecord {
  id: string;
  task_id: string;
  agent_id: string;
  confidence: number;
  estimated_cycles: number;
  bid_stake: number;
  escrow_amount: number;
  created_at: string;
}

export interface BidderRow {
  agent_id: string;
}

export interface BidRepository {
  insertBid: (payload: BidRecord) => void;
  getBidById: (bidId: string) => BidRecord | undefined;
  listBidsByTask: (taskId: string) => BidRecord[];
  listBidderIdsByTask: (taskId: string) => string[];
}

export function createBidRepository(db: Database.Database): BidRepository {
  const insertBidQuery = db.prepare(`
    INSERT INTO bids (
      id,
      task_id,
      agent_id,
      bid_score,
      note,
      confidence,
      estimated_cycles,
      bid_stake,
      escrow_amount,
      created_at
    ) VALUES (
      @id,
      @task_id,
      @agent_id,
      @bid_score,
      @note,
      @confidence,
      @estimated_cycles,
      @bid_stake,
      @escrow_amount,
      @created_at
    )
  `);

  const getBidByIdQuery = db.prepare(`
    SELECT id, task_id, agent_id, confidence, estimated_cycles, bid_stake, escrow_amount, created_at
    FROM bids
    WHERE id = ?
  `);

  const listBidsByTaskQuery = db.prepare(`
    SELECT id, task_id, agent_id, confidence, estimated_cycles, bid_stake, escrow_amount, created_at
    FROM bids
    WHERE task_id = ?
    ORDER BY bid_stake DESC, confidence DESC, created_at ASC
  `);

  const listBidderIdsByTaskQuery = db.prepare(`
    SELECT DISTINCT agent_id
    FROM bids
    WHERE task_id = ?
  `);

  return {
    insertBid(payload) {
      insertBidQuery.run({
        id: payload.id,
        task_id: payload.task_id,
        agent_id: payload.agent_id,
        bid_score: payload.confidence,
        note: null,
        confidence: payload.confidence,
        estimated_cycles: payload.estimated_cycles,
        bid_stake: payload.bid_stake,
        escrow_amount: payload.escrow_amount,
        created_at: payload.created_at
      });
    },
    getBidById(bidId) {
      return getBidByIdQuery.get(bidId) as BidRecord | undefined;
    },
    listBidsByTask(taskId) {
      return listBidsByTaskQuery.all(taskId) as BidRecord[];
    },
    listBidderIdsByTask(taskId) {
      const rows = listBidderIdsByTaskQuery.all(taskId) as BidderRow[];
      return rows.map((row) => row.agent_id);
    }
  };
}
