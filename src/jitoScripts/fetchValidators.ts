import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js"
import BN from "bn.js"
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

const JITO_API_BASE = "https://kobe.mainnet.jito.network/api/v1";
const RPC_URL = "https://api.mainnet-beta.solana.com";

const VAL_STATS_CSV_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../report/val_stats.csv",
);

const VAL_STATS2_CSV_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../report/val_stats2.csv",
);

const connection = new Connection(RPC_URL, "confirmed");

// getInflationReward accepts an array of addresses; keep batches small enough
// that the public RPC doesn't reject/throttle the request.
const ADDRESSES_PER_REQUEST = 20;
const REQUEST_DELAY_MS = 2_000;

/** A single validator entry from the Jito Stake Pool API. */
export interface JitoValidator {
    identity_account: string;
    vote_account: string;
    mev_commission_bps: number;
    mev_rewards: number;
    priority_fee_commission_bps: number;
    priority_fee_rewards: number;
    bam_connection_rate: number;
    active_stake: string;
    jito_directed_stake_target: boolean;
    jito_directed_stake_lamports: string;
    running_jito: boolean,
    running_bam: boolean
}

interface ValidatorInfo {
    name: string,
    client: string,
    identity_account: string;
    vote_account: string;
    mev_commission_bps: number;
    mev_rewards: number;
    priority_fee_commission_bps: number;
    priority_fee_rewards: number;
    avg_stake: BN,
    epoch: number,
    inflationRewards: number
}

var valInfo: ValidatorInfo[] = [];

interface JitoValidatorsResponse {
    validators: JitoValidator[];
}

const toStakeBn = (activeStake: string): BN => new BN(activeStake);

/**
 * Fetches inflation rewards for all validators in `valInfo` whose `epoch`
 * matches `targetEpoch`, batching RPC calls and setting `inflationRewards`
 * on each entry once its reward is retrieved.
 */
const fetchInflationRewardsForEpoch = async (targetEpoch: number) => {
    const epochValidators = valInfo.filter((validator) => validator.epoch === targetEpoch);
    if (epochValidators.length === 0) return;

    const voteAccounts = epochValidators.map((v) => new PublicKey(v.vote_account));

    for (let start = 0; start < voteAccounts.length; start += ADDRESSES_PER_REQUEST) {
        const batch = voteAccounts.slice(start, start + ADDRESSES_PER_REQUEST);
        let rewards;
        try {
            rewards = await withRetry(
                () => connection.getInflationReward(batch, targetEpoch),
                `getInflationReward (epoch ${targetEpoch}, offset ${start})`,
                (err) => !String(err).includes("Block not available"),
            );
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            if (reason.includes("Block not available")) {
                console.log(`Skipping epoch ${targetEpoch} inflation rewards: epoch not finalized yet`);
                return;
            }
            throw err;
        }
        await sleep(REQUEST_DELAY_MS);

        const fetched = Math.min(start + batch.length, voteAccounts.length);
        console.log(`Epoch ${targetEpoch} inflation: fetched ${fetched}/${voteAccounts.length} vote accounts`);

        for (let j = 0; j < rewards.length; j++) {
            const reward = rewards[j];
            if (!reward) continue;

            const validator = epochValidators[start + j];
            if (validator) {
                validator.inflationRewards = reward.amount;
            }
        }
    }
};

/**
 * Fetches all JitoSOL validators for the current epoch (or a specific epoch)
 * via POST https://kobe.mainnet.jito.network/api/v1/validators
 *
 * @see https://www.jito.network/docs/jitosol/jitosol-liquid-staking/for-developers/stake-pool-api/#2-jitosol-validators
 */
const fetchValidatorsForEpoch = async (
    targetEpoch: number,
): Promise<{ validators: JitoValidator[] }> => {
    console.log("targetEpoch", targetEpoch)

    const response = await fetch(`${JITO_API_BASE}/validators`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epoch: targetEpoch }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Jito API ${response.status} ${response.statusText}: ${body}`);
    }

    const val = await response.json() as JitoValidatorsResponse

    console.log(val.validators[0])

    // const data = parseValidatorsResponse(await response.text());

    return {
        validators: val.validators,
    };
};

const PAST_EPOCH_LIMIT = 15;
const API_CALL_INTERVAL = 1_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withRetry = async <T>(
    fn: () => Promise<T>,
    label: string,
    shouldRetry: (err: unknown) => boolean = () => true,
    retries = 5,
): Promise<T> => {
    let delay = 1000;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === retries || !shouldRetry(err)) throw err;
            const reason = err instanceof Error ? err.message : String(err);
            console.warn(`${label} failed (attempt ${attempt + 1}/${retries}); retrying in ${delay}ms: ${reason}`);
            await sleep(delay);
            delay *= 2;
        }
    }
    throw new Error("unreachable");
};

/** Returns the current epoch from Solana RPC. */
const fetchCurrentEpoch = async (): Promise<number> => {
    const epochInfo = await withRetry(
        () => connection.getEpochInfo(),
        "getEpochInfo",
    );
    return epochInfo.epoch;
};

/** Per-epoch performance figures cached from the Solana Compass API. */
interface ApiCache {
    epoch: number;
    vote_fees: number;
    priority_fees: number;
    jito_total: number;
}

/** One row of val_stats2.csv (the `votes` column is dropped on read). */
interface ValStatsRow extends ValidatorInfo {
    comission: number;
    vote_fees: number;
}

interface EpochPerformanceEntry {
    epoch: number;
    leader: string;
    vote_fees: number;
    priority_fees: number;
    jito_total: number;
}

interface EpochPerformanceResponse {
    data: EpochPerformanceEntry[];
}

const SOLANA_COMPASS_API_BASE = "https://solanacompass.com/api/epoch-performance/validator";
const EPOCH_PERFORMANCE_LIMIT = 14;

/** GET /api/epoch-performance/validator/{identity}?limit=14&offset=0 */
const fetchEpochPerformance = async (identity: string): Promise<EpochPerformanceEntry[]> => {
    const url = `${SOLANA_COMPASS_API_BASE}/${identity}?limit=${EPOCH_PERFORMANCE_LIMIT}&offset=0`;

    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Solana Compass API ${response.status} ${response.statusText}: ${body}`);
    }

    const json = await response.json() as EpochPerformanceResponse;
    return json.data ?? [];
};

const readValStats2 = (): ValStatsRow[] => {
    const raw = readFileSync(VAL_STATS2_CSV_PATH, "utf8");
    const records = parse(raw, { columns: true, skip_empty_lines: true }) as Record<string, string>[];

    return records.map((record) => ({
        name: record.name ?? "",
        client: record.client ?? "",
        identity_account: record.identity_account!,
        vote_account: record.vote_account!,
        mev_commission_bps: Number(record.mev_commission_bps),
        mev_rewards: Number(record.mev_rewards),
        priority_fee_commission_bps: Number(record.priority_fee_commission_bps),
        priority_fee_rewards: Number(record.priority_fee_rewards),
        avg_stake: toStakeBn(record.avg_stake!),
        epoch: Number(record.epoch),
        inflationRewards: Number(record.inflationRewards),
        comission: Number(record.comission),
        vote_fees: 0,
    }));
};

const writeValStats2 = (rows: ValStatsRow[]) => {
    const output = rows.map((row) => ({
        name: row.name,
        client: row.client,
        identity_account: row.identity_account,
        vote_account: row.vote_account,
        mev_commission_bps: row.mev_commission_bps,
        mev_rewards: row.mev_rewards,
        priority_fee_commission_bps: row.priority_fee_commission_bps,
        priority_fee_rewards: row.priority_fee_rewards,
        avg_stake: row.avg_stake.toString(),
        epoch: row.epoch,
        inflationRewards: row.inflationRewards,
        comission: row.comission,
        vote_fees: row.vote_fees,
    }));

    writeFileSync(VAL_STATS2_CSV_PATH, stringify(output, { header: true }));
    console.log(`Wrote ${output.length} rows to ${VAL_STATS2_CSV_PATH}`);
};

export const getValidatorInfo = async () => {
    const rows = readValStats2();
    console.log(`Loaded ${rows.length} rows from val_stats2.csv`);

    // One entry per validator pubkey; each API call covers all recent epochs,
    // so a validator already in the map never triggers another call.
    const apiCache = new Map<string, ApiCache[]>();

    const uniqueIdentities = [...new Set(rows.map((row) => row.identity_account))];
    console.log(`Fetching epoch performance for ${uniqueIdentities.length} unique validators`);

    let fetched = 0;
    for (const identity of uniqueIdentities) {
        if (apiCache.has(identity)) continue;

        const entries = await withRetry(
            () => fetchEpochPerformance(identity),
            `epoch-performance (${identity})`,
        );

        for (const entry of entries) {
            const key = entry.leader ?? identity;
            const cached = apiCache.get(key) ?? [];
            cached.push({
                epoch: entry.epoch,
                vote_fees: entry.vote_fees,
                priority_fees: entry.priority_fees,
                jito_total: entry.jito_total,
            });
            apiCache.set(key, cached);
        }

        // Mark identities with no data so they aren't re-fetched.
        if (!apiCache.has(identity)) apiCache.set(identity, []);

        fetched++;
        console.log(`[${fetched}/${uniqueIdentities.length}] ${identity}: cached ${entries.length} epochs`);
        await sleep(API_CALL_INTERVAL);
    }

    // Patch each CSV row from the cache entry with the matching epoch.
    let updated = 0;
    for (const row of rows) {
        const cached = apiCache.get(row.identity_account);
        if (!cached) continue;

        const entry = cached.find((c) => c.epoch === row.epoch);
        if (!entry) continue;

        row.mev_rewards = entry.jito_total;
        row.priority_fee_rewards = entry.priority_fees;
        row.vote_fees = entry.vote_fees;
        updated++;
    }
    console.log(`Updated ${updated}/${rows.length} rows from the API cache`);

    writeValStats2(rows);
};