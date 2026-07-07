// Fetch per-epoch earnings for every vote account in val_stats2.csv and write val_stats3.csv
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { Connection, PublicKey } from "@solana/web3.js";

const LAMPORTS_PER_SOL = 1_000_000_000;
const REQUEST_DELAY_MS = 2_000;
const RPC_URL = "https://api.mainnet-beta.solana.com";
const ADDRESSES_PER_REQUEST = 20;
const EPOCH_MIN = 981;
const EPOCH_MAX = 996;

const connection = new Connection(RPC_URL, "confirmed");

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

const VAL_STATS2_CSV_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../report/val_stats2.csv",
);

const VAL_STATS3_CSV_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../report/val_stats3.csv",
);

const FIREDCANCER_CSV_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../report/firedancer_reports_validators_2026-06-28_mtd_min_stake_0_all.csv",
);

/** Per-epoch SOL/USD prices from the reference earnings table (epochs 981–996). */
const SOL_PRICE_BY_EPOCH: Record<number, number> = {
    981: 74.99,
    982: 62.81,
    983: 66.06,
    984: 64.48,
    985: 66.15,
    986: 68.15,
    987: 74.44,
    988: 71.7,
    989: 69.97,
    990: 73.55,
    991: 69.61,
    992: 67.9,
    993: 70.78,
    994: 73.98,
    995: 77.92,
    996: 82.64,
};

/** Epoch date ranges (DD.MM.YYYY – DD.MM.YYYY) matching the reference table. */
const EPOCH_DATES: Record<number, string> = {
    981: "02.06.2026 - 04.06.2026",
    982: "04.06.2026 - 06.06.2026",
    983: "06.06.2026 - 08.06.2026",
    984: "08.06.2026 - 10.06.2026",
    985: "10.06.2026 - 12.06.2026",
    986: "12.06.2026 - 14.06.2026",
    987: "14.06.2026 - 16.06.2026",
    988: "16.06.2026 - 18.06.2026",
    989: "18.06.2026 - 20.06.2026",
    990: "20.06.2026 - 22.06.2026",
    991: "22.06.2026 - 24.06.2026",
    992: "24.06.2026 - 26.06.2026",
    993: "26.06.2026 - 28.06.2026",
    994: "28.06.2026 - 30.06.2026",
    995: "30.06.2026 - 02.07.2026",
    996: "02.07.2026 - 04.07.2026",
};

interface StvApiResponse {
    validatorId: string;
    voteId: string;
    commissionReward: number; // inflation reward (lamports)
    votingReward: number; // leader rewards (lamports)
    votingFee: number; // fee spent on votes (lamports)
    votingCompensation: number; // voting compensation (lamports)
    jitoReward: number;
    epoch: number;
    mevCommission: number;
    totalStake: number;
}

interface EpochEarningRow {
    name: string;
    client: string;
    identity_account: string;
    vote_account: string;
    epoch: number;
    dates: string;
    leader_reward_sol: number;
    inflation_rewards_sol: number;
    jito_reward_sol: number;
    voting_fee_sol: number;
    voting_compensation_sol: number;
    total_sol: number;
    total_usd: number;
    sol_price: number;
    stake_in_epoch: number;
    commission: number;
}

const toLamports = (value: string | number | undefined): number => {
    if (value === undefined || value === null || value === "") return 0;
    return Number(value);
};

const lamportsToSol = (lamports: number): number => lamports / LAMPORTS_PER_SOL;

const recalculateTotals = (row: EpochEarningRow) => {
    row.total_sol =
        row.leader_reward_sol +
        row.inflation_rewards_sol +
        row.jito_reward_sol +
        row.voting_fee_sol +
        row.voting_compensation_sol;
    row.total_usd = row.total_sol * row.sol_price;
};

const readValStats3 = (): EpochEarningRow[] => {
    const raw = readFileSync(VAL_STATS3_CSV_PATH, "utf8");
    const records = parse(raw, {
        columns: true,
        skip_empty_lines: true,
    }) as Record<string, string>[];

    return records.map((record) => ({
        name: record.name ?? "",
        client: record.client ?? "",
        identity_account: record.identity_account!,
        vote_account: record.vote_account!,
        epoch: Number(record.epoch),
        dates: record.dates ?? "",
        leader_reward_sol: Number(record.leader_reward_sol),
        inflation_rewards_sol: Number(
            record.inflation_rewards_sol ?? record.commission_sol ?? 0,
        ),
        jito_reward_sol: Number(record.jito_reward_sol),
        voting_fee_sol: Number(record.voting_fee_sol),
        voting_compensation_sol: Number(record.voting_compensation_sol),
        total_sol: Number(record.total_sol),
        total_usd: Number(record.total_usd),
        sol_price: Number(record.sol_price),
        stake_in_epoch: Number(record.stake_in_epoch),
        commission: Number(record.commission ?? 0),
    }));
};

const uniqueVoteAccountsInRange = (rows: EpochEarningRow[]): string[] => {
    const accounts = new Set<string>();
    for (const row of rows) {
        if (row.epoch >= EPOCH_MIN && row.epoch <= EPOCH_MAX && row.vote_account) {
            accounts.add(row.vote_account);
        }
    }
    return [...accounts];
};

/**
 * Batch-fetch validator commission (%) per vote account per epoch via RPC
 * and patch commission on every matching val_stats3 row (epochs 981–996).
 */
const smth = async () => {
    const rows = readValStats3();
    const voteAccounts = uniqueVoteAccountsInRange(rows);
    console.log(`Loaded ${rows.length} rows; ${voteAccounts.length} unique vote accounts`);

    const votePubkeys = voteAccounts.map((v) => new PublicKey(v));
    // vote_account -> epoch -> commission (%)
    const commissionByVoteEpoch = new Map<string, Map<number, number>>();

    for (let epoch = EPOCH_MIN; epoch <= EPOCH_MAX; epoch++) {
        console.log(`Fetching inflation reward metadata for epoch ${epoch}…`);

        for (let start = 0; start < votePubkeys.length; start += ADDRESSES_PER_REQUEST) {
            const batch = votePubkeys.slice(start, start + ADDRESSES_PER_REQUEST);
            let rewards;
            try {
                rewards = await withRetry(
                    () => connection.getInflationReward(batch, epoch),
                    `getInflationReward (epoch ${epoch}, offset ${start})`,
                    (err) => !String(err).includes("Block not available"),
                );
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                if (reason.includes("Block not available")) {
                    console.log(`Skipping epoch ${epoch}: not finalized yet`);
                    break;
                }
                throw err;
            }

            const fetched = Math.min(start + batch.length, votePubkeys.length);
            console.log(`  epoch ${epoch}: ${fetched}/${votePubkeys.length} vote accounts`);

            for (let j = 0; j < rewards.length; j++) {
                const reward = rewards[j];
                const voteAccount = voteAccounts[start + j]!;
                let byEpoch = commissionByVoteEpoch.get(voteAccount);
                if (!byEpoch) {
                    byEpoch = new Map();
                    commissionByVoteEpoch.set(voteAccount, byEpoch);
                }
                byEpoch.set(epoch, reward?.commission ?? 0);
            }

            if (start + ADDRESSES_PER_REQUEST < votePubkeys.length) {
                await sleep(REQUEST_DELAY_MS);
            }
        }

        await sleep(REQUEST_DELAY_MS);
    }

    let updated = 0;
    for (const row of rows) {
        if (row.epoch < EPOCH_MIN || row.epoch > EPOCH_MAX) continue;

        const commission = commissionByVoteEpoch.get(row.vote_account)?.get(row.epoch);
        row.commission = commission ?? 0;
        updated++;
    }

    console.log(`Updated commission on ${updated}/${rows.length} rows`);
    writeValStats3(rows);
};

const getLeaderSchedule = async () => {
    const { epoch } = await connection.getEpochInfo();
    const leaderSchedule = await connection.getLeaderSchedule();

    if (!leaderSchedule) {
        console.log(`No leader schedule for epoch ${epoch}`);
        return;
    }

    const leaders = Object.keys(leaderSchedule);

    console.log(`Epoch ${epoch}: ${leaders.length} leaders`);
    for (const leader of leaders) {
        console.log(leader);
    }
};

const smt = [
    '11AMA4mnNbsrPQeuoNN7uiZVJZtqEzQHrTfa5vnbcjk',
    '1KXvrkPXwkGF6NK1zyzVuJqbXfpenPVPP6hoiK9bsK3',
    '1Link6hB1NpkCwJt3ZtpQKZszKauhEcKgiWjaU8PRDG',
    '1ggyZGbYtEo1WrV1kmXfnvhPeSPxrYAXoDBeApnszLT',
    '1i1yPyh843bTfi5qPgqozTbDcEX65rUNEFcUT2KAs2i',
    '22rU5yUmdVThrkoPieVNphqEyAtMQKmZxjwcD8v4bJDU',
    '23SUe5fzmLws1M58AnGnvnUBRUKJmzCpnFQwv4M4b9Er',
    '23U4mgK9DMCxsv2StC4y2qAptP25Xv5b2cybKCeJ1to3',
    '2AKKnirWVZMhnzuwqpizw9SwfZjGpRFLx2zCCNtPWpbc',
    '2Eq6YD8P8QXTeoz9h6JHjgZ55t8RSxNdx4waMDCoPmQU',
    '2GUnfxZavKoPfS9s3VSEjaWDzB3vNf5RojUhprCS1rSx',
    '2Le6TjeEescF87qDA8Ftdz6U8Kq6SNVwoLJLhzBCHUr5',
    '2Mob8FJkb8chZY5pTBMpKfLwgZAQHE5i9jAC5zbASitD',
    '2N7v8pDKDYhtBUJBQUgxvysUjgM9s4ULPCmeEiPWTf6Z',
    '2P9ZYA4vBoBBr56hrEFTmrd5ctuz3r7wtvRYmbgk6jRL',
    '2Rv9npqdWE1mLPsT1r2obn3xtKmA5afkxt8GsWeLnKoc',
    '2UBhtRuyr9nvWsUnrbWrvJiYWEU8TVBD4PLYQJKiRa9H',
    '2VKu11f8zc3huqDQUN6WJTFpX32PgHpXXjf72P6YvYMd',
    '2Wf9V9rPeVRUTfmWdPedCJuWVr6MFfyLuigEq42DuMDc',
    '2X5yarNUWGyyiJDtRoPATvJYeNecvWG7zCkBrY2J1to1',
    '2X7WoaXX9KPqNrNfvguhnwo3rjFPNsfw2t75fGjWRthz',
    '2XmhZKHmfjku3T3nC9xKhgr5bm1CAmWXqNsNt49mo82C',
    '2abwQG3v2xRemFxRszVHSfnjJNe9zu5X8duKgxjyLeaK',
    '2bpfa8JbFfZUGUsedDsemu6vQUxbhcEM8ALSH3PgXd2d',
    '2dfgsiSaZ51QYPsECMYMG247PXxyKdwkV9wTHoQb8YEC',
    '2dxz129YxB1xtf7Mx6HUT5JspexArNNtQt84FYueWZV7',
    '2gDeeRa3mwPPtw1CMWPkEhRWo9v5izNBBfEXanr8uibX',
    '2icWF7TvxyycF7d1NHpMZYuJJqiRy2h7wmjFSbqUij1B',
    '2jS8AX38m8F9C5juToW1FmTufEbb1DfDzZJj9HSJcWwo',
    '2m1A2WM1vte7RWz5xTTw4i1SiXmngVtXhqFERaUjoAAb',
    '2mDrrmhSzpSyaF12izGk8hnFjtKCGeCFPwQHpRiJDby2',
    '2mMGsb5uy1Q4Dvezr8HK2E8SJoChcb2X7b61tJPaVHHd',
    '2nhGaJvR17TeytzJVajPfABHQcAwinKoCG8F69gRdQot',
    '2oHUYyW2PU9VJh4XBs5TbGgzdernunvGqyKth3kxW4ns',
    '2t53LvZfskcpXkdwLaBnfZLbNgyVHPu2BNFpcRBaEBhM',
    '2ufnDYz755WuHqGCczry1ACTNUVZdn2cm43bCyyPSZtH',
    '2uxEHizFmmnLekKG2LZJwxNabhpymEYfdVCpgDxjt87m',
    '2zykwzzo1pd3H2oSj5j5SRLTvmpa9Nr2S2Bh8tTVd5Tq',
    '32jCuWyy4aJjyv4gd4DSGBHmFU5KUSSfqbmPb9GpMin6',
    '32ke3uf1qL3xLqbwzU76T2sbG2XaJrGuSCNdUnien3zm',
    '38zm5bBgDaNRSQBDUAL72kMH3RsX4UKmZiNmmrjuTq8W',
    '3B2mGaZoFwzAnWCoZ4EAKdps4FbYbDKQ48jo8u1XWynU',
    '3BeharBd3j4sKQp7Qze27JLQLd9AEEwGTX9TC7dXYSNw',
    '3CKKAoVi94EnfX8QcVxEmk8CAvZTc6nAYzXp1WkSUofX',
    '3DaPk6TdeGnEBwTR8fEyZSLkdayk6vZXrqGZhAgYK8BV',
    '3DaifGfDESUzer5ggUeo6UDjqEKMkCpdNSrrvyuggHVe',
    '3JotfSFPaod4KVK7nj7ULvcq5PjUBdZNVGracNkJNhrt',
    '3KNGMiXwhy2CAWVNpLoUt25sNngFnX1mZpaiEeVccBA6',
    '3KiDz3wuZrJfsgKt5KEvRb1WPpbci1PWj78aPVF5ei3F',
    '3Pfubj3ytkRxFAGwFb5vtacuZJUxko5Du39xie9MBXuC',
    '3RXKQBRv7xKTQeNdLSPhCiD4QcUfxEQ12rtgUkMf5LnS',
    '3Rv6ZVGUuRczP76322LyhTTYw2iM4avV4B5xFJocQJer',
    '3SkE34PVeGck2ArEffFKjihrQgURsvnoTAhitsNXNzXd',
    '3V2xaccDpFib4DbTksdiveNDmiwpXBqSWyjSof3w1Bg7',
    '3WDh9HgusCujDmXCVhophLrHvoKHQd1Sd4uFHz1Awo35',
    '3YVoK8UN62dyiPZnGBzBTkGdwsVmmK1MpRoLcxNRs9BE',
    '3YX7PQuESmR2h95FDgjahEQjyCBhmY1Ts2MsrM1Kg9DS',
    '3cZSHGfNdaULpFAvGbWbxpVwzXB4gHdk8NFucPNR5pgA',
    '3psxMyr7rQzywVp1MXKd1XFmFz33NjydzCoJx9t2sMQW',
    '3rqEEEGjHRyndHuduBcjkf17rX3hgmGACpYTQYeZ5Ltk',
    '3s97yjq2MhoPVPC3U9VeE3Z5S643Pweovg88ysvrQPw5',
    '3tm92VTxwyZ5MDhGoYR4tVTkwWYkzfam6hwBjauUACCk',
    '3tzpLMWRkWucvTRWU5PjgKzN1iwJuV69yCCjmuuo4gTk',
    '3x9nibnhgBHWKMRiGnsXJELRBjviQpKyigfrXtKW27KJ',
    '43Am3PKFeo9cACpqYL5Sk95rpVdxLw3Mc22PqRqZXEW2',
    '49j9bnkdgVNxLwsZ9h88sPR5MYEmsUyKrrJ6ZW8ijBrb',
    '4DraK9wUrMSpzbGjUbSWTHAhJimMyB49HyKhvfwe6e51',
    '4GEEKSwuiBHWTff9WaqrDcToZjbX6KYdyB4c578Zxse2',
    '4JahMMrVRS1gimWoXpD5H6KwKc2MrsoTDFMaStMttL1E',
    '4Kbcyn7JVPAWLRLPsNGTPmcNMvCkLTw51ZLRhqsUC6jP',
    '4NwpynvugnHvyLzr5h9Y7mw44saGJXDNoBjm6wgMiYDr',
    '4QNekaDqrLmUENqkVhGCJrgHziPxkX9kridbKwunx9su',
    '4SNKY7GCp7ohY4AawND5Cc2D71sWMWN3Uifo854yvtks',
    '4SsMncJdtKiUcDtukkX15mqei7WiuQ9yvRtQrQW4reWC',
    '4VrjyXQT61WFSjuG3ehgqZUK1jqvYqB46veQbXLotq3n',
    '4W3jdXyqhLCjzA3Liu8ZNjViwrc6N9YjSB7obbxfjcKE',
    '4XspXDcJy3DWZsVdaXrt8pE1xhcLpXDKkhj9XyjmWWNy',
    '4YGgmwyqztpJeAi3pzHQ4Gf9cWrMHCjZaWeWoCK6zz6X',
    '4aRPyjsqqFsf5488a9QAaHJLQJMGwoL5P6wRtLmroe2d',
    '4b1onMDEasBh4BuPekQWijx3BYR64hAE1z2jJyeZUkck',
    '4k6wgP5WPBKQpsFGtzuXNrjcTE2fKWLj17nDvFeG5zSF',
    '4mtXJ5pUcMMB4t8cLbi7zfDJCHfYLRrQb4qSLmh57sKL',
    '4uH4G6YiD5G8rU3mtPg73C2Uqamrqedy3FboTZcZrh6x',
    '4vcmYPfLztUckU3c3FvXDwSq8aDNDqwEpvEiqAv97LGJ',
    '57i31UEyDg4koaZMZ1wAHbYuezXv3AVaHtvJgJarxt3f',
    '58KprHKFNHgH1Cvo4QwxWkDeJNaSQVteCoAAFUWjtESn',
    '5AsoSeQtLoN8eLsf3wKrR3LwxHME4sTBGR6dpTCP1k3H',
    '5Cchr1XGEg7dbBXByV5NY2ad8jfxAM7HA3x8D56rq9Ux',
    '5DYpYgKgHV5aswMXBLp3UfJnbbzzFnGiJPpcxVAm56bG',
    '5EhGYUyQNrxgUbuYF4vbL2SZDT6RMfhq3yjeyevvULeC',
    '5FbKKGdEaFcxGxxaLKVvBes2JxiKbreh8w2ZpMcSQ2a5',
    '5HCTsoKM7vwjubSZSyVWChaHQ9sNNRB1d2SuvL3eZ6Y6',
    '5HYjArGt81naevDdwMaEx8yeGNw9jYBSDJa8YavT9Mp4',
    '5MAGJ3zShtXMMVXjZRoFqtFF7XhP8iLSyZrxdL7KpjcB',
    '5P35CJVKU15Rrh5M6EVkre23EyA3K34kAut2GXhHKM7W',
    '5RvfTSowms7BTYaBj8SxVjj7ELAAKdQadKsuNpmBAwCs',
    '5TGfVQV1S3wHE9hkgGaQkRoPC7xZxiqwMcjQZxVYsf1j',
    '5Us18hLZPXJTS4QVuGSsUw137Dyd2tgBaem24Xsf5nBS',
    '5VrW7YNBccVnhnZVmooCePdLFcs2UjfxRT3hoY9mN8Ec',
    '5XKJwdKB2Hs7pkEXzifAysjSk6q7Rt6k5KfHwmAMPtoQ',
    '5ZqveVffQPiUbkjBg4KD9kib1MKHLqiFno4ke9jSq9qk',
    '5aD6KB8g4MPt3xJafmMmun86hHMDnoFiGbd5gYiMFZw7',
    '5d9Mdc2Zk8as8GL1AxQeXxv5htBBvC5bjfmsXC7UUWwG',
    '5ejbTALcBsKQ7Cj1iSuu2mY5jqbYHqh9gF5ERXLiYj1z',
    '5essVpBYvocZkQnkrWsMDfRPwtp4BeihJRaweKLR4dRn',
    '5fSQdv4zsAJNx6RKpGho6sL6rY6a8nziaqcmwaRJB9NE',
    '5ghoFEVrsXeAPB6SUmBpZ2xq3KvHEjNMeSaBnxEBXkHV',
    '5ikB9XZNVsjwKb6hHT3FS3So1Z1SrDvU5yaniWEQyDEG',
    '5ivRNcK1yThcK3koZR1oikAfuNm6rj1LceMskayoVSzc',
    '5marvipGzf98hxnoJFXsZbGHSXcEQ3yRGJ4ps7D3V4ou',
    '5pPRHniefFjkiaArbGX3Y8NUysJmQ9tMZg3FrFGwHzSm',
    '5pZvwjSpGYCxpJeySwSbSAji7kZe4YntL7rQvXM3YcNT',
    '5t4shVsKnUqgjmhK3fFNsvyju2E6Rd7cc4S5pmqqEVEW',
    '5tfcGyf3NQFcufDigvbRt9kWoVN2KPEkBRUY3UaC3Zwm',
    '5yEnvhM4Ld3UZs2n173J2iR369E1ddcbQYeLSZxk4cYj',
    '5ysfTZ42VT1TjnjzQShZSrix7wdVtjXwssocSeYKDs5d',
    '5zm9g3zgAPWzX3wmUB2JtTkcwCqe74NWsTmt5wLFwCKK',
    '5zuNci3TV79w6zLoJZzbZujMvkVZb2FcSPhgv9aT24AK',
    '61QB1Evn9E3noQtpJm4auFYyHSXS5FPgqKtPgwJJfEQk',
    '65pHd5P2VrehonT1cdJ2JUnq5wi3WUgfL3A8RhYH7Kg7',
    '6NDen7aDi65apHo8m1Vea4nuS6LyjQeM6pDNqcW4Q5Pg',
    '6Rk694kh1QTyQkirdb1uDZmS5xqG9bNaYtxx8d311Mr7',
    '6TkKqq15wXjqEjNg9zqTKADwuVATR9dW3rkNnsYme1ea',
    '6WgdYhhGE53WrZ7ywJA15hBVkw7CRbQ8yDBBTwmBtAHN',
    '6XKqyUVUcpe3CNucjF6gk5zonJDqNGvob6kaTy4Ps1U',
    '6aDs9tUm2gErcPn2c1TZnp5cu2bQV9BzyuwW4baWQYd4',
    '6bBw4LYVzXQoNs1TH4yVavtpCu5cdwYGvmuXVcZmNeKy',
    '6c6RrC9TWNgiVXnbZ6hehNuhyh81pZK1yAj5w2nXZTwi',
    '6gL3uHvuUjaPp9mTBf2VZ4tpKiYhbWyPrAPboGByzEHd',
    '6gnbmed7kzwQVQ7ghsjgEuCoYmGeWciV2qCwni6WS6HU',
    '6k1YkmTKwPRUhChnxA9ryJmbtuQMbro4xFTL6mL9jycB',
    '6k5hZkHGa4x3xEU7Wz2LxWwueqZtVvX3fpymGugB14yB',
    '6pEtDovpyd1zUMYPuNhMCPU37sUTEAtzzgoVVAh1G1JL',
    '6ptuwW4rg5A3wP9hNKxeymG3QhSagugPd3grnMTGJwWG',
    '6qwYjs5vCSEKaTMBbHinnW8fvdGj1r8cpzPoAV1EHKsw',
    '6vG7fgweSfvY7JRViG4HwKgV9u6JKhMpf2bqr6TKNjUW',
    '6xFDLX751L7H9d5fQT9sf2SM5RWWE9LDgqz25pPDbWoJ',
    '6xUK9Nbonr4eoJNtHGoUEMmYKoPz5mipKzyDBv6deX4d',
    '6xWLi1TDSh65fWsSqE1zdvANTSuVDRMx4ghsGJwgunS8',
    '6y7V8dL673XFzm9QyC5vvh3itWkp7wztahBd2yDqsyrK',
    '6yFGGAgYpBxgYPuHW4rv7hJmhKrUiXKyHkpVGaYtKrwE',
    '71F3mXrwguQ7euZkJAuSZ8o8N4EDAVnTsjMpffXEhaPy',
    '722RdWmHC5TGXBjTejzNjbc8xEiduVDLqZvoUGz6Xzbp',
    '73hojLdq1vZDSxeVQEqVFJ4iwLngdvEJPEpEHkSdv6BZ',
    '74MzXStH8pLPZjbNxZKdtDGJehur2JgjZNeTPqSn37nE',
    '74Xkp2iLXm315h69sFRiCFjmKnaWkMV8W2LgJwPRSgN5',
    '76rcGHdPvgs8G1XrzCXUTWtwgT59AFDvpB4VbTS2TBBJ',
    '777idJ8gG2cZXjc5Wvcq7RBtkvcU1TJ8WoLQSHaU8nN2',
    '7CR3Jq4ny2tsr3DX3DvyjoU8TYs776MGkU6nLMWjAqCT',
    '7CR6whiYULVf1Knj4J5PxUS37opdk8UAx2WnDzBQKiVe',
    '7EzbSahSfSjeRexHcNDLDpzHBAGBLjLKtjbmuoQnEtjE',
    '7G4RfctwLLgqG4ZWfCirU8dfJd87mKQWgB4EHQRv8i7v',
    '7GkMBmtrTZz8QbjSe1sXvAUtz7Pp42SQxfT5ymmJD4We',
    '7HMHSdQkjDwz9Q5zAhEy83uzW3XHJchjdpMYapKXcKt5',
    '7MTjmteQHhthwwTZhUzsc2dP4NBvGNRqj8jzdqNxHFGE',
    '7Nn8qBJey7vXtVFMNBbbuN8UkujU8Y6nWzbHVGuf49yV',
    '7Nu9ckgtjobZ3MkbadGFKEvRymYuah9HmcxiUJKMM9NB',
    '7PdKhpKz7T39vZHFL1UfcYNDsLvay6hp4KPQq1aUckFf',
    '7PpXQgDb9eCHN1Uudgi77Wm89cRz4T85YgDw83qvaJXd',
    '7QQGNm3ptwinipDCyaCF7jY5katgmFUu1ieP2f7nwLpE',
    '7S22CYpfBRV1p8cTqWXFD4HwfqfNx3hAhfpdj8E2bYvJ',
    '7VZM7YHcX73TpGoXDeBu61g4QKC86GwAEnew8dA7Y2xn',
    '7ZjHeeYEesmBs4N6aDvCQimKdtJX2bs5boXpJmpG2bZJ',
    '7Zm1pE4FubFYZDyAQ5Labh3A4cxDcvve1s3WCRgEAZ84',
    '7cVfgArCheMR6Cs4t6vz5rfnqd56vZq4ndaBrY5xkxXy',
    '7d7x84jiVtqpz9NK88ocLmu4L15uhdnzMEDmo8Py8oVi',
    '7knvB4bbqHCKuNp3ef2hJWdwqoH6WAUi55NQt6LdRfkx',
    '7mF8NZJdREuM1uwYcvKffuY9QJBEoHhNp4hZ4NS2fuXW',
    '7nzTzRZzezmugqE5ZjHRMxarhXunpwZ2PUdjV7uYzt7A',
    '7pR7t5axFfkg2VZB1uAuFNUvpAeowq2v15J4gw5MmHTB',
    '7qGNnXKW1e3DsqEaSxwxMdBTFsrK73XtWTmkGitRyMQc',
    '7tqeaFKsg2K9xKnQWe61w71AtCZVMQvG4hbFAiFAngYw',
    '7y5VhV4fkz6r4zUmH2UiwPjLwXzPL1PcV28or5NWkWRL',
    '7zAHbRxEQaNjKnQMjFm7j8LebHSGfzsQDdm2ZpUNPa7G',
    '84gC25fbFKYueR9WEfreUysk1n3ZFxLFDDjbyqeqGpoW',
    '8AkVj5aAtJ27tYXeq89cnSf68V43NarFHMx2iSDjZv7c',
    '8GLRbAstsabZuZUx73AoyfGi1FRCWSUhRgMugFyofEz7',
    '8Nvaxzif1NrdvxNkRetjT8xJvd33EHkKVrfL8EDkgaNy',
    '8T8AJfUCXwPFwEMmjca8gCRSktPrqbUBVa6ggNyhLhFJ',
    '8W8v28d1fBZE1fkaaHbowJM4hGZGnVHWNK1NyhUsob6Z',
    '8ZQg3K1V1Z2BVJkjmnxpi43WKhjPGXphzu5QmBkJibSP',
    '8a4juhtQScHcXPAcqVF3otxLMqxZMDALcE3FEVGBnKu8',
    '8augxYLUge2iWmitQMwbcBL5VQEpsM6aJdRofhwpnzyw',
    '8aySXUFrqJz5kath6aVijrkBH8ZtxMWJGhYXwYBpKmHK',
    '8cnksBVjDPspn3AvmxJd8JKUdh4uWDDXzDemPmDctaHi',
    '8cqck84coxk8TGXYBD95QosKCEA6fKwXLevcEv3oGmu8',
    '8ebFZA8NPLBZD91CwsG1HWQsa2B5Ludgdyf5Hi3sYhhs',
    '8hAYbagNt7CMBooFfqVJhBgLqLffpjXTWJMk8yybjJsN',
    '8nbE53mcKhy74HLiGZ1q5HRocwiCvgh49csSaHSdtukr',
    '8pyp3vfVPRziYdAYEyqkwytdBbdVbQmHqfQAVDcRV3w',
    '8tjFeSApQ85ThoQXT28acfF2KUfQr3TvTdirSkzNnYC7',
    '8uJiHDJ1b7UDQ4KFsQGJXK9nUCkokdKRJymg1Wy9nxvM',
    '8uPW9msN75rfaKiwy8y8NxEX5zSk2WejtVv5YhZr3jCo',
    '8vk6QpG93JSaQCSgnycBsv5qmfQBk4qC9FjNA35E5JhU',
    '8yjHdsCgx3bp2zEwGiWSMgwpFaCSzfYAHT1vk7KJBqhN',
    '91oPXTs2oq8VvJpQ5TnvXakFGnnJSpEB6HFWDtSctwMt',
    '93Q99nhdKjuSe6WNXgMBbC3s8QVQEAoHKt91PNRkUkMn',
    '97jbhVBYcSmwGXjrx5PPWXucDsVBqwyoQ6rzP3B6eeMt',
    '99rG5AhkVagxJ7y8NpMAmy1h1u9GhT3h1Cimu2X3cwaJ',
    '9AW87WqARQonyJYhx1G25fKfvjURFYVmHs79z1NUXDPD',
    '9D3o3EYeknhTrRvXS1PnD2euGXnMFa3HwpYBq5gPZJDA',
    '9FXD1NXrK6xFU8i4gLAgjj2iMEWTqJhSuQN8tQuDfm2e',
    '9GHvMeJ4ZWuAX6sDGscFL1TBMszx2EehnrcTVUy4MZJQ',
    '9PRr9k87HjjdLMRkxtxygidjxVta9VQ1kAsqgLBWXKdQ',
    '9U4WqNGVywKt3gG9HSt9tGVXBDXJvgid6BVweRysaJmg',
    '9UM8wQ8F5oMiRcP5YdqD6Lr4krpBWCD8LtgQYoisJd9i',
    '9USijQaAfSzw6gWbHNq68VVigmj3HvffDJYhbK4tfquB',
    '9UbU7oaVXX6t7bMthxzzGPnWumFNxoWqUwX3qsrxb4pp',
    '9W3QTgBhkU4Bwg6cwnDJo6eGZ9BtZafSdu1Lo9JmWws7',
    '9Wmaz9VPpEnH67ZqrvYd9bcH66DtsGaEKcSQE1ac5wkf',
    '9WzPWqKSqbE5PT9hMsmCDFjzpurAXEYCE9qrpVWp28KR',
    '9bkyxgYxRrysC1ijd6iByp9idn112CnYTw243fdH2Uvr',
    '9dH6wfdJVgnDcbCUjT8rkmejAzTnGQaFarmLfvBYXANK',
    '9eGrDohdNTAo61DRHyfMuqKWXqYnA3i254Wiszxe8FoY',
    '9fa5wcqnAQqHyn58U1vHHLuZW5GXLcoho7hKT17jGJfZ',
    '9gFxqsXbFyrKXUkqpAatonn47uYZ7sEZSnMxhzQoXrUJ',
    '9hQqNe3DQTiwhspatewA8EXhz12e6sq5UJVJ2qNRwnTf',
    '9iFPQbP1jGkj67sXg6YLLGRUBVEDMcapdS6jmCZSnz8R',
    '9jxgosAfHgHzwnxsHw4RAZYaLVokMbnYtmiZBreynGFP',
    '9pBHfuE19q7PRbupJf8CZAMwv6RHjasdyMN9U9du7Nx2',
    '9ppJrpsbbuGNjiMhhD52Ueco4KXUzVfrtNQ6tAcDab4f',
    '9q16BB7WGmBxf1nJTdxH5zPnBUhtHqdqXqRFjSjuM4k7',
    '9rkJMARqK6VBkcxGfKBAwnA44gPAfGxPbPsfsggFNDSQ',
    '9ueKvL3WiLM4mNUZrfWqPTYY2Np5YwzFTYvAiPibx1Zq',
    '9xcXe4WRAfbVoVgQmFD5xgFHioL9dD7c74pQZ7PeczT',
    'A1vqhA2fS6K7CvHsJKX1ACcHJFEmyRg4KuR5pctHANy4',
    'A23LfQn6khffj2hGhGfXr6P52W2pxrVcCaHVQLYQgiX2',
    'A4hyMd3FyvUJSRafDUSwtLLaQcxRP4r1BRC9w2AJ1to2',
    'A9mvukTd77EbRoBX4ydSCFQHdu5bsRFkNXTTRstA8FAC',
    'ABC1U4cf9DZMwqy8ktEr4WJj8VHmVBQibbC57gEJthwY',
    'ABREU5YkQcfpDZymoQ97iGUgQcfgjctWUUxEMfumiPdV',
    'ACvL73V4GNnxPVfZ7K89jCrYurLyzpEuE9qirjvh2Xmi',
    'ADjyeNzWd8yhEjCVyAqT87eqoyGRbimERQsNhFQcXjop',
    'AEAJtnjjB19XFreJH21UP8rfd12f9kxMmngwZG3tGXbP',
    'AEHqTB2RtJjegsR2ePjvoJSm6AA5pnYKWVbcsn6kqTBD',
    'AG1PsJMQcutNUX64RD3bAhW7NpxWeFkqkgGizBznYFKW',
    'AHZxzLeRGRfNVFrCmP58iJgEwbcXyZeAkZ32CmbfEmYR',
    'ALPHA6rdHZkx1om79xp47vX1iZXcbM3qfEwLyttZ1T7R',
    'ALp2GdA1eJV8vZHMHazCtTxNXe3BLUSco9LDASgjDs8R',
    'AMukCLCr52XxsEjXoDxKKxjNg4FpnsReXNaQx8aR6DJF',
    'ANC1u9sY36q3mi2MyVhtz71un8yLgTsFBUuyLcSPzKsk',
    'AS4i8EXUZnPbmNT5ZXmoTEbrXQrbFoReiWwwFB43Ds5z',
    'AWZhUiQjrjtxL8MEMWsCFbMausFQKkdTnDsFW2i411hN',
    'AWcCdYG7Dy6GX45c6QMPbgGwgRZPKcBDT4bXGb3QrVRV',
    'AYY1TCe347UZ7zueBmF4MyoFkeEZquRUNVBNoUZiRoew',
    'AccReGBNBdUCEJ7ZyP231jw7uVJ3eF9u4cLBFAyqQuWm',
    'AdSHK6vpQnwHRSw7jXUwjMEytmhFwnynZSENhvpAxL1y',
    'AfZTWYoFQbzqCMmUBTD7XwxFvjob1FVyCvkaXRryxtKc',
    'AiBEt9kE8yZ4CnaLfTCGMp7Fg2wCtqhPTfvJ8D3zrLfu',
    'AiDoLWFKzNxSXKeZ4zym2TEPkg6F4kQ3YBA8WhANVPEq',
    'AicQr2zCWBLiBwt2r6o7iTemmtyE7q5pTKyuuupbXEQA',
    'AjGby82yXeYgj3kmng9y3c4nQpZFmiPpJKecLJTHbfbP',
    'AmhQFcGvH2hjkucP78rn6GMKSbstYwyFpCDVKZUwBGrG',
    'AmjX7CerZbHrU814UeBp2gJC7gANNG3KrP4c3RyD7TSD',
    'AoUwfPuiEek2thVRDhMP7HbQb9rguyab4rDiz2NAfwwA',
    'AqyRvpjjSN6jWYPxijoJwhmKwJFk6fRYDh9fQZHcJ2o7',
    'ArMBx6veRq33ffEP9sxHafiPRgrtzww4XvbwZbSMfXiM',
    'As9NxA9bCfhrVLAFyGeWG5X5iLYPGhU3R7nLfX3tN6am',
    'AsMpvJ3DZ2Ydu1WTRMAyMH4QjSLiUG39rKzfzvtE1bWr',
    'Atom7LRkdXj6MBoWJPgjaetrCMrgB9nnkQBYXTWE8Z3S',
    'AurseT3W3tk1dATBWAXtWR6oubBgECqintfcvP74teU3',
    'Av8EnYrPBnSJHK5e2wmTdnCpSy7nzmBgyFaUKSyLnBfe',
    'Aw5wEMXhbygFLR7jHtHpih8QvxVBGAMTqsQ2SjWPk1ex',
    'AwcMVMvmT1aCETVYV42WE1cSMCyNp4vZqVjLsvs6dM4o',
    'Awes4Tr6TX8JDzEhCZY2QVNimT6iD1zWHzf1vNyGvpLM',
    'B94PGWcxE9iEDov8sZobTkqEY96Yb5gfcsYWSWpQxh6S',
    'BCJN2vZFAHDYmufBDcbD5UAQHSyerXfc6UQkgX3mSWuh',
    'BCS95L5JHBWHvWkcEJBEF3BH5QHxKcPeaTgoYmHLvfFh',
    'BCeczqpTRPigndHVJu1KEzno1Uhb4hjrE7ttmAndrV1p',
    'BFmqBsaGjeYA7gHpReKmnVkRyhqiMmHoR9ttv1crWmzy',
    'BGAjnivVWqLqByqCVT9dSyPUFicvyJrz7vRvrvui3SEk',
    'BJvrWSfonXnS2Km8iA9KLY6D6vS3GcsaUwUNPFBumTca',
    'BLUEHGDihXD9CqqC5XFSQzDC3aS5jASohb2BAsXaJokR',
    'BNtHBLo1L2vAG7PBQ6mJvWz7GqVPxBnioXsY2Gjtubrg',
    'BPKAfGkkzF5u1QRjjB1nWYYbPMUCMPJe1xZPmwEMNMCT',
    'BR1aTt4ZZUCwWJDkSYf1hqkYJjo7Mb7Ar8iVTkeSwUB8',
    'BRAZAtTTzR2Es8c98hJvcngerTEyRGSdgkHU59n4A6GT',
    'BSGMRbK97DcgLe4u4kfNQnmTVZGVnwdtKQBJqWRBTZxU',
    'BSVckjdW2f8kcXPGcrPPtV9kUDBZ8w8PjrrGVnxgEdwq',
    'BTGPbq4KuFENn4CKuaKGqkaDd3TJD3TEgtMjSrsZnMLb',
    'BULKzVM41WAyQZfL34vxqdsYwEYH9mJAJyzRS4xraf8b',
    'BUokhb8pPF9MZuzW3rHLr6jzakgcz3NDq2PZkpiVv3jb',
    'BUv44cVtsdvU9z2BfFGk6s5JZZWrmVnq5qCaii5ARyyB',
    'BXAxLMMMUNYfC1z166VjWHR3WjTmqzLxB837o5ghmRtH',
    'BaDhUB1eWfunwD21Tu3WywyYQ9wZx5hS9WXeHHNGZUPy',
    'BeSovDCzhEAfgwDyXBuhmCFKsu5WQ3PaX61GEfteNzXM',
    'BeaCHioStqCEFDFxKwAEzyrUPYxqnBPhJ98gDKeEiTPb',
    'BhNnboEZb3mKkVADMH11cYGWCqefAfmhzx5rU4eRTKGY',
    'Bi9kKNxfW2XqgCmLcuhHt6A3x55GuAGmrVZxRHLyVoQ4',
    'BiGcsiuFCLuiTzXoQgfLdge9sfpwr55YzdT8Kp7bCXmS',
    'BirdeyeK5yooepHNNgaW2bGGDD2jmib4oSRFTHyELbZ1',
    'BitokuDHQiAhpUKrwx1VssAAoW5Rst8zB6gpfoaxM3Kh',
    'BkoS26vBuaXnSowACdChi4WKid8UwmuPNhEJWa8KsLHd',
    'BoNKmNCGvoHS4CkKvYRnF21iEpUP827pZjhFGdA4t5as',
    'Bs19Z9SokV1s46jutN9tqqaCgYf1GsVyyytVfkzwn9qK',
    'BtsmiEEvnSuUnKxqXj2PZRYpPJAc7C34mGz8gtJ1DAaH',
    'BuoZ7q6faiJNTN24r7Kcj8dp96axs5XPEKXmWGsh2pDE',
    'BuonuQoAR74GoMwCFhxKWVWWSGGt2wfbNmQ3cizaJ97G',
    'BxkAkLR2W3agWtjMXBNvhxmB8vsn7zhjNQcyfost99KY',
    'By8MseMKtZQQaQjMHJiyetmc5AC8RZZv8C2ss33ktrHt',
    'ByszyWdqC3rVMWy8f6jwK5cmwkpwYdwsr7UL58xS5vnm',
    'C1ocKDYMCm2ooWptMMnpd5VEB2Nx4UMJgRuYofysyzcA',
    'CARBN9PY1Qej1aCg4885pfoYH8EHfjWuMy59pVa48ky',
    'CAo1dCGYrB6NhHh5xb1cGjUiu86iyCfMTENxgHumSve4',
    'CEL22Qx7p85qY6gmhCZaYJrrnynJitkVRMQo6qZdT8Ns',
    'CG4tRANBKrzUmpv93V5sgftjQznBdiJsc2yPCzZWWuS9',
    'CLsFr1KZVbAyz16iFpwg2e4hiekR1unpwyxfNdjBMaoE',
    'CMPSSdrTnRQBiBGTyFpdCc3VMNuLWYWaSkE8Zh5z6gbd',
    'CPcDFHCAKkr5Kp9T5aQWJhXV5J6iFj141NMQ87L6poPL',
    'CTDGxTK789ZvhgyHZHtSnxTtysbyY1mrywXEJiYYqXxC',
    'CTwsruptUccEtZGNxBDbuusHYxkBX3P6ndrxVjSG213y',
    'CVGwNaC1FaG95hRBHUuieDLyQU2hJuGhPduu2cMyHnw6',
    'CVRr5oHCAAooVbYze7CvXtRp4FUtkMCSqBZU7MVu8v8e',
    'CVgwMrWo9chKEuEPCe6Za9KJe8jamnAcoeWzaMeNubr6',
    'CVvaeDPR2o7P1eawG5c9TPFLzSXAewwPovPmREaEL4Cm',
    'CW9C7HBwAMgqNdXkNgFg9Ujr3edR2Ab9ymEuQnVacd1A',
    'CZanBzZHFzrGY5qKzaX3CNhJ5smHEMTWFFnoeUi4J6dr',
    'CaveyttUBTKttncu1e4RF814XjuoGfYv8cEsiKGDNCPX',
    'CeJjdkRwfqYjrb7ZgKgqTurxx88H6kZyRadJwNJBcQwC',
    'Certusm1sa411sMpV9FPqU5dXAYhmmhygvxJ23S6hJ24',
    'CfgRXmp1LEYr97EaT2RyoL2cSvtWgJh52Bes89RxVSoW',
    'ChaossRPGKnsVhX1GfPC78yq5Sqju4cMThcAsKZNz5d6',
    'ChorusmmK7i1AxXeiTtQgQZhQNiXYU84ULeaYF1EH15n',
    'CiR8HNCfkjtcongPmP2DRdZPnFgjSbN5gsXdjmsXXHcB',
    'CjmXSapt1ouz3CZzgkRJckBEwMSo5fVdVrizLeRscwYD',
    'CkCMabrc3HgBgDkeKPXkbWuQpUuSqW7zs1Mg3HFArx61',
    'CoG8d9Fp2TFJRkAmrPMiPsGhQWHzdTTVoegEp9svRgmJ',
    'Cogent51kHgGLHr7zpkpRjGYFXM57LgjHjDdqXd4ypdA',
    'CpNnGGhgVATJAbzHUXdrcGfpPiGuZyPka4QUmH7YgavX',
    'CpdzCVzaR9gjFymmEVE8xHboJFHaDnimRZ448cMBs6Rn',
    'CpgSfd6QUoBw1267rTtJoZhELqC5q7isKLojBifSbNEE',
    'CpuDNi3iVoHXbaT8gHpzKe6rqeBasoYjEKi21q7NRVJS',
    'CtvdyHYt8cMuGVHFarV2RADfoCdnrbd8e9jAsB225uMW',
    'CtzN7ysR5rX69qd168Aosbuc83mPozhi81bEHbG7ecNP',
    'Cu9Ls6dsTL6cxFHZdStHwVSh1uy2ynXz8qPJMS5FRq86',
    'CuStTdKU5nWev5YKxMHyFjiHYG2CnjZ3rrPa8r1G2hTw',
    'CwyVpfmfSiMeCexi3JgUNvaiDfYN14cLDjzT99zcBuD2',
    'D1A4F2yh38JLQExKjDiCi4G2tCMwj93c3sikseSSePKe',
    'D1Vbgkrhp1TmLGhfUD1urRMx5Ntz9AqQpgdX8DR8QMC1',
    'D2RV1q6FgePVVjrMa7AMzVbvvAeg5oS7TAV7qdNKSDsX',
    'D3htsc6iRQJLqCNWcC2xcZgUuvcd1JT8zoYNqraNcTQz',
    'D4r6Rcua2L7nHHhdaiZe2k2bTfPg2WQqcNYpG6bugvCG',
    'D8kuk3qEiVBGwYkuMGKfBDwuRi6jjRkzjAZg45fdaRLx',
    'D8xKNftHzFcCekENuTEcFC1eoL9y8wNHEg4Q5z57KK4e',
    'DB7DNWMVQASMFxcjkwdr4w4eg3NmfjWTk2rqFMMbrPLA',
    'DCKyEmMENQMtLXgbmUoHRmgP9XdJ9HsR5WxrKnSDCzKA',
    'DCdTPyDbXNHrmdv4ZyPPzEfY4mPAqH4hDPtowAteoNgv',
    'DDnAqxJVFo2GVTujibHt5cjevHMSE9bo8HJaydHoshdp',
    'DEU4agzdUCA5oZ1QSLxCyZb1smvdu5j1NXXsK2r823Uu',
    'DF1owXYZ1fk5vWyHJ8s1cJeAozgkqsi1JUVqvktqrpwd',
    'DNVZMSqeRH18Xa4MCTrb1MndNf3Npg4MEwqswo23eWkf',
    'DP9iBgK9c7tJYb83KhxQMFNc1LXYu7nE7EhWpEzQnjmg',
    'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy',
    'DTSUkYHd2e9P2HLyZfbLarsbDdPhQUhZnWjRYuJZQRC8',
    'DUND26mEDfFeaPsVof3YvbXDRvpuQX7HMUJrLgEWzYw4',
    'DViARWAWKkxAzp4UCgbw5B9pLSrBY3PaztFErcwgVUKX',
    'DWvDTSh3qfn88UoQTEKRV2JnLt5jtJAVoiCo3ivtMwXP',
    'DZKTNGR3r4Akj3G42ReZatKhkmgEXoZjk5Ed2tFwRyqm',
    'DeXsDvvZzKhVux4YfDFE6p4acJLGzr8yKt5pSTjzZB8t',
    'DeepM3FDWaAb7o53rvyZk5YvHLG3FvDiVXJLRY78z51p',
    'DefiihS7gLkj6xLjjhcr87bFuwpVVNYpeNBaBeFe56CY',
    'DiFeTctQSaNczJNmZ5121kYqLaBe9wDpM9sjCzTELJLE',
    'DidkDYa64DEMx97P4iahDwsWtgUTnLiEhHSMUbQGihi5',
    'Diman2GphWLwECE3swjrAEAJniezpYLxK1edUydiDZau',
    'DiveRaPKviyDnQyiiMFdV4rujsCBJzMNvPjKfvGNLGvL',
    'DnQBmTJyLbBMgJYQLJDqJz25AJModNkyexL5LdVRGnG4',
    'DrifTrN923QaouP89UxkQzFGbumKPCnfkNYQRwmZxatz',
    'DupN8puwoPdFo9EYm8AXemEn9cMsore1QmZzfPaxyUG4',
    'E1r4Psq84tHfQ6aPTvvDka4U3u8zPVD7gEUrH25RdxHL',
    'E3mDbFMr8yZcCAZx5wPUFCRmLX31u8Nnj4jPoPc54h3F',
    'E4xNK4UwGnMtkdiUPyx13i6NkFDdW9Gw9NFGY93wEdGZ',
    'E5UXkzUxqEXpeDf3WsrMZHTs2ZSSBpAz7G4hpGwgRGDT',
    'E99w1XfS4UNM1xUKXWEuDmj8Mduy7u65jm2NCULTspSV',
    'E9hD3ikumJx1GVswDjnpCt6Uu4WG5mz1PDWCqdE5uhmo',
    'EATpCzQNs8BzZh1mx1hXMAJm3o1MLXakTXr4UEmcsY7f',
    'EAW9vxqogvdPNapq7QTDpiVTHK6o7begUhPVnf854VTc',
    'EBk678aQvc3cUkfGyoehfw21JQfJXjmWuBeopYc89RSV',
    'ECNnK4VjcKTsABiw8FAp3JCE6tCmYyrEJthYVyMazmxi',
    'ECZx4Dfyn2o55KTYbM9r3Dt4VZRcrdfdrst7sUbWgrdU',
    'ECeaWy82CxpeJQr3EG3XNmYXc9NrVeWDH5ag9Lt6TPVR',
    'EKgSCR3ahdypkxXcBY43ZNxdmyZqPkKNPey3rwKjqbz7',
    'EN5F2BU5juUEWr9zRNNqKuQMi9zBUY1YLPHV5EyMrvnW',
    'EPFZFVrXuveEQar9LaEkt5kDRPMnbvK54qu5FwCxpkcy',
    'EQhTjikb1L2jvxsCaSW2o2TuRXh4Do6HzBEWCxpeM44W',
    'ETcW7iuVraMKLMJayNCCsr9bLvKrJPDczy1CMVMPmXTc',
    'ETuPS3kRfLufz5VSYN2ZrePoEVSZSpgVPKz3MUZpYe3x',
    'EUDis6LJeJzDHTEBgfHGQyjHp63XZkGkx4E69xunC2Ej',
    'EUcJwf7jXskRE6NZBtFPVH2EedNvNYko8LL2WT62XctB',
    'EWARp8Syq8cTWGWHtP5LT9fKAn5GvXfSCH8LfAwpgQ6m',
    'EXckihF3qmguH5znjhfzLvHsbk2E3nEW2DqNh4MMnDMm',
    'Ed9WjPnZfAXsPttcqxMwj94qsuXVRyBsyXnDkxFva2Zv',
    'EdFUcP2f6j9iBg5BqsgJn3WDr1JieiKCo41hZ5Zrsk6w',
    'EdGevanA2MZsDpxDXK6b36FH7RCcTuDZZRcc6MEyE9hy',
    'Ee8dX3qtwrDRnxYK6NGQfmMeKT3Qpp2QZHpxiAiw23W9',
    'EfPYQ4BUMiKa6736qqrtnCBGkUSRDGSr1WvtyUgWHuyp',
    'EkvdKhULbMFqjKBKotAzGi3kwMvMpYNDKJXXQQmi6C1f',
    'EvnRmnMrd69kFdbLMxWkTn1icZ7DCceRhvmb2SJXqDo4',
    'Ex1AxFCipXGfSxgvXPPT3nPQUARddCduHwKR6jHiXAaT',
    'ExCHWgfeJyKRzpfryiQn4W6aYaWhbSAEnsoUnBGNqjWD',
    'Ey3DkEVbfBxfWmkTsG7Hqj7jshYf5Zx9H8462Zjjkykf',
    'EydLxzdWfD434DDxZYXkTcajvK5VKH7p6CofEDCRUkJ4',
    'F6kVwubXEfZZo6e4Kozrtg7WoWk5wTRmrC8pwoxSLa7S',
    'FACb6bbTDRBHCK999V8ox8jga5JBnt1r3vvzmAYAMv2o',
    'FBKFWadXZJahGtFitAsBvbqh5968gLY7dMBBJUoUjeNi',
    'FBbqKvwLfKGZrKrfSbPJz4ymQ7zMarhRyZtu1RBkSe89',
    'FCWkGAHDWK41ANjiaoPudkCZRkvTecaEkoZQugezUnpr',
    'FFevTkywysWf8PJvH4DZkEp4v9ks9HJPJhZWbhhJiYnr',
    'FGiEdzde7Fco2WLpNQMat299hUVoykJdaA5hxdmCzHiS',
    'FLwV8tm3pL8pZj6d927VASzPrgW51Gf4nRJuTewrfega',
    'FNKgX9dYUhYQFRTM9bkeKoRpsyEtZGNMxbdQLDzfqB8a',
    'FNTPSUuRpDoJx1hwFmB5ncNLLMX42aE83P4hsFYUfNRL',
    'FSyAsxcE7g8pSSEu5nx7Hkz44rMZiYio5Wz8Lszh3Nbi',
    'FWwwP9tNttSy9dJFxwf6ebXWfc6VJXqFNMTccrMiLFTH',
    'Fb77sbwgXmtjmkjkaoSckGp5yg3nqdtD8zf1dyxxiCSf',
    'FbYX2uN573G5WsgiPdHU6fS5PNUyjdXfGfpZNkYUuT4k',
    'Fc6NNdS2j3EmrWbU6Uqt6wsKB5ef72NjaWfNxKYbULGD',
    'Fd7btgySsrjuo25CJCj7oE7VPMyezDhnx7pZkj2v69Nk',
    'FdH9QEQBxPQfaF2JpcjgdfcMnDb7rjZkCDRCWLRjTQwj',
    'FjYEr2UCeFzNfAKiFrbhG34Zv8LxbmfHYAFhAfc7SLQL',
    'FoXyHJXdQGK2eHoTjSAzHq4hzxWdJvpGgyzrtPS9eAk',
    'FoigPJ6kL6Gth5Er6t9d1Nkh96Skadqw63Ciyjxc1f8H',
    'FphFJA451qptiGyCeCN3xvrDi8cApGAnyR5vw2KxxQ1q',
    'Frog1Fks1AVN8ywFH3HTFeYojq6LQqoEPzgQFx2Kz5Ch',
    'Fudp7uPDYNYQRxoq1Q4JiwJnzyxhVz37bGqRki3PBzS',
    'FugJZepeGfh1Ruunhep19JC4F3Hr2FL3oKUMezoK8ajp',
    'FwnWx7x99rGwLmipzz8ii15NqcHkKRo2oS1Y7j6LivgZ',
    'Fy7RCjDdFLG8wLn7TBKbccaKwYX1FetdSoVDREdUHf5o',
    'FyLVPAKkgdAy8Gn9jnFYN5yjC1ubQWRkw2EHt2UnC8uA',
    'FyrwfMaomErzqrFUXMjCJ7mA4u81DsiDdrzC3MJD6d4j',
    'FzQqaDStQQHs52YKeCnDovwSqvyZBCgs2kJcmvoFZwaS',
    'G1bLKfyNm7zsmmYEL9dyxBvMtxpFcwy2s84bHDj2ZFUY',
    'G1eAmANVWf6ZeoxG4aMbS1APauyEDHqLxHFytzk5hZqN',
    'G2TBEh2ahNGS9tGnuBNyDduNjyfUtGhMcssgRb8b6KfH',
    'G3a3iYZKNLbivothF3twqcaTCEvoPb9uJ2bFc9DNKkBQ',
    'G4GT8z4AKWNoy3x6nuzxW83UfFXLXzrwn7DZQt4GvWdU',
    'G9vCpJUUSpEm4zPwzSNpDmZ8MGwLEbiSLV59EBzCGvzM',
    'GBQ2GvTzmjXMu97dr7WUnLKYTNim1aoZsYS53KYXAAAA',
    'GEM1N1UE3C8BB8EaaEPrcFvT3iLMVrurknjW5AYjUReR',
    'GFXVa19rX6iwfs3sLS5UvX9Exu2usRsG4V5MRMDRo23V',
    'GGX3BEoZDqjxcw4AbCdu62ZTMrkpSgmPt81oP2mVuZNS',
    'GK2YYwmQk58xA2k2SeugY3i334SJVViqTT8sT5wim3Dk',
    'GQiWnDYrzHMALWG9avt5FCu1wisAQHjGY5ve7GMBiPEe',
    'GQzMeEMwAR44ugoNCifTb5NdRKos1GduDUPeNh6AgV46',
    'GREEDkgav1ox1jYyd9Anv6exLqKV2vYnxMw5prGwmNKc',
    'GRT7yrpfF1TEvp3RmCzu5YZ74B4EueVMPg5NYtSiPwtD',
    'GSTampk6BJRKSDkzhaMM49R7qRx98MTPYYWvKbp83XKc',
    'GWJyUxzcVwRRtpLuLiu1mpiUQsZ4onYFAYfCjQnuLmz5',
    'GYx8kpp7SsRwtQEEsGQjAxb4hFMMmT91kFJuDeky3YGQ',
    'GiYSnFRrXrmkJMC54A1j3K4xT6ZMfx1NSThEe5X2WpDe',
    'GkFT5nmcFVmJiLwuE98PjdF3LReMeq4WbejFHfwrnsgw',
    'GmCxjmjKZoaKN1DKunbYq8RCYib94Nm3sHyncFfofaF5',
    'GoeW4aFK4dGoekJySgUynWDxBZiQJqm8GDAF4H53tDK9',
    'GqDCbnafLmKkdqiqf278jDLXqjjZMB2sViZQtR82jPUf',
    'Gv9gguvrAkgQtB5g5a3Un7trcHCxLYsk8vSojLmQMsWV',
    'GvfaiJUhNCRZGVGumsEF1eHDb8JpAeFAyHSrTifyhrbt',
    'GwHH8ciFhR8vejWCqmg8FWZUCNtubPY2esALvy5tBvji',
    'H8fHToVcZPi5bupGZohGPX2SWs8NHzgFKQ31wi5n6oux',
    'H9ENbtmy2tWFtAJNmpC8xQtbcr1NTp4FXLdphRaG8L2T',
    'HDxxzxzHnkGTQLGN1DpVvByiNapmrjztt7C7xzhnrqTn',
    'HE2REn7YRhFEghuctv3y1dUEK9aWhw8QQSUpRiHd819r',
    'HEL1USMZKAL2odpNBj2oCjffnFGaYwmbGmyewGv1e2TU',
    'HFTcVVrX93SJwYHAiiHAssb3c4zXqSsF4mNjg5arGPEj',
    'HH5dA42XF1HxNk1TRpG6LuKfLViMYNdAz5iWrFM4hWFi',
    'HLXxkmjb47spcmbbKi3UCfZ2qmFY29t8MN562AEmh2Qh',
    'HLnodbYkL5PFA8hjAZDkm5pGzV7eLTvcs671AW2L6St9',
    'HM1KjNaXa4w8K4gCXbieoMh5gUTNeUhg9fvdXMKeBW3L',
    'HMWXfjaeSHhww1wvdBhqhHVP9v96mFB4LJ9xP2MXbDGH',
    'HT41udB8mLZZf7tev9tUoHYJ41TP8GWZ6zFMbjiviXk5',
    'HTeRsa3gm3CGrizMoCrtWj4uBZ1NKYcGqh8jfBu2u3Jo',
    'HVXXmNKkmDZbZwj74iL2Y9Wu4SyrchBoxAfFYVAktLrG',
    'HW4zorvt6xDwhU36RqjcWNwU8YMj9tiqnAafBKW4cqV',
    'Ha1iade1AH3B12K9SccfWoPdFtQKKQsj2ZyWwxcjqJJU',
    'HaLanfo94ezLc3JZ55qqxr7W3qbe1PprJyv2uEtriEqN',
    'HarmonicyK3BwamKNtWnQAmUeK4GYGXXzeD9FD8WMyZi',
    'HbidP4hpQdwhkzrxder3x3VNPt6DQnE25gFG46napD2p',
    'HcZvwZ83PfjrQDiq3GLHxisTs17aGURs6bJ2LwtmL4qv',
    'HgozywotiKv4F5g3jCgideF3gh9sdD3vz4QtgXKjWCtB',
    'Hj2jzpAp57KyM3SmnYwJbDVrQ8tTWizMon2hhzYzwxet',
    'HnfPZDrbJFooiP9vvgWrjx3baXVNAZCgisT58gyMCgML',
    'HnwMGBAw5PxaX56eSYc969MorEy2NzEMPLkmBkdnJmeq',
    'HpcB5Qg8Y9E73dUkot5e8HkgAJbExsYeUzniY4bCuKac',
    'HrpWeJSYnQVtZe3BKxFCBrAEr8GRCmYUbQev4hoGDBs6',
    'Hu7pi2Xg5Kav8vSAUUr5CCZaEmMCzT6FgCTpueu3oBtW',
    'HwN6eoEe9N3kwHi66hpQDBMFPk6ASQGthWKPX5MZmisp',
    'HwRia5HUmQcvundpC6iFqwfK4iVNKRSmYm1NKsrMkZBC',
    'HyperSPG8w4jgdHgmA8ExrhRL1L1BriRTHD9UFdXJUud',
    'Hz5aLvpKScNWoe9YZWxBLrQA3qzHJivBGtfciMekk8m5',
    'HzrEstnLfzsijhaD6z5frkSE2vWZEH5EUfn3bU9swo1f',
    'J6etcxDdYjPHrtyvDXrbCkx3q9W1UjMj1vy1jBFPJEbK',
    'JC7bH7HSZoDhwggBXtRF31cVt71WiizY2J6YDDQfG5er',
    'JD549HsbJHeEKKUrKgg4Fj2iyv2RGjsV7NTZjZUrHybB',
    'JUPiTERrZqgf1jUyR7dSkhMx4Kn2qJyekWsg3LT1h4b',
    'KAW1LjxH73tRBd1XsaqsRsgeERFkg4WpdXUSqR4QjkW',
    'KAoSp3EudGqUBXv46tQoDwbZxSm3iXa9wM2aF4ySbJJ',
    'KTMkUG8WCw9FdH44jLMBpc1teGafnYL6SgP4fHHbsNM',
    'KoLibrJsbABbtmtFPc7nPvDxT81rc4UPM7mY9xSLjpo',
    'LA1NEzryoih6CQW3gwQqJQffK2mKgnXcjSQZSRpM3wc',
    'LFGGGJtnBLvq78DyMz1gTeedM6f8owck76qHThDABBC',
    'Lake8NXDThihebhxS3Js7mFnj9fthmus93zEdsFNrsL',
    'LandXxwDqbxP2aaC2LfbrXytwXJtPUpiRr3J5kpy5xx',
    'LeDbQ99QT342j9S5YdyXLrsq2Gu3T3dMGajExdAuE3V',
    'LiFiDJwJjW98MB8wxcnXpafKYsuz1hwpUkuszkERiX6',
    'LimeA3gMLb2SjxrKbP7NsWk1UwTZrw4B6Ctc9dmVU6E',
    'LitxAVo3RnYXD2sX1TyRJxfnKy48amXgyGiysPZjZwE',
    'LodeuWMHPiPj2PUHUyca2bkpFv9HyzR3gaDBmGJ9TSS',
    'Lua1fxRRHCnjVAYdfGyv2GbUsRHGM2DN2wgpWuF2WSb',
    'LunaowJnt875WWoqDkhHhE93SNYHa6tfFNVn1rqc57c',
    'MARiKM3t7pDCyXtvLq24ErWDAvYu84yXqCthkR1GS33',
    'MBVyz9s72WSfUmbr1S8fgHjDJQkPs1Q4Wxi6A2Mees9',
    'MCFmmmXdzTKjBEoMggi8JGFJmd856uYSowuH2sCU5kx',
    'MFLKSo4XDfrBf4FByx76zYM2dXSWcigag7ec2bCHTR4',
    'MagiCBYNPD9iTBXqiFybAFCREQzG6MSM4LmFLXQZxuV',
    'MargusJeV9bkePFLWbbzRNsMVo3Re6h9wKB5Ago8Tfj',
    'MicoB9cA9R6jsicdhzWFjwd9HMkV8FA4o3WxYU6Z2yz',
    'Mwz8VgAEnPtfqS62r3ixrFiMJwnNfEwR141CGnsTo5k',
    'N43JWBg42ZoUFMkHsRUVbP7wGVdxaHKanqaF9BBNiFC',
    'NATsUSZGohWw8xtLdxG4yus21UCkaes4FLfM2eqKbRk',
    'NLMSHTjmSiRxGJPs3uaqtsFBC2dTGYwK41U18Nmw5kH',
    'NWY18yrPHsTogTDq78HpB51D7gC5AGRsvJ5pPqSchkH',
    'NdMV1C3XMCRqSBwBtNmoUNnKctYh95Ug4xb6FSTcAWr',
    'Ninja1spj6n9t5hVYgF3PdnYz2PLnkt7rvaw3firmjs',
    'NoditgWLFbgnbPjfHP8QQrjxvuhCayTZWHw9pM4EJpu',
    'NordEHiwa6wT5TCjdeWJzpsA7DSmWQPqfSS7m2b6cv3',
    'PAD9aPiKJGcbGxuVLbc8o4Vf65GPq3fJQ7PkHWuX6a8',
    'PAWsME7oYbjt5TRNc11mBa33JhKnQr9AYherdr9YAZ6',
    'PKdLMugp1Mf88Ji1GkdqRDBewaUh2cqg79CBEo6eJoQ',
    'PRGNnb8DxVcP2WjSHfVRGgc8SkA5u6dbMwoTVV1BGKN',
    'PUmpKiNnSVAZ3w4KaFX6jKSjXUNHFShGkXbERo54xjb',
    'Pid6HQnMCFb9izqX9i7X6ePdUPieGmjHoPxC1Jfooix',
    'PuRposE4utktenW49N8DCtVzdVEwYrmsrroboEUram4',
    'R2D2imoV8nXk1ngT9v4dEK65We4uLNyUarTBdWbFruq',
    'RAuSNo4DRjo83uGhdgg4fPqYBVszi1KsrQGpqcPHK1D',
    'RBFiUqjYuy4mupzZaU96ctXJBy23sRBRsL3KivDAsFM',
    'REA1zKzM5WjDEcpB27Zx2Rk16foNPtLGTETy93LLgNw',
    'RLMS1pv3YKi7CSUCKTNcFN5fFkXJc2SmCwPhbQpqZJo',
    'RNXnAJV1DeBt6Lytjz4wYzvS3d6bhsfidS5Np4ovwZz',
    'Raydiumm3w3a4nGanDBLkUtKxMFooSPmeg9qwUKMsMc',
    'ReFiqMfGnc7tW8WQtFFcJRPZSDAWDBnAsdoFYF2QnfR',
    'RoYFUUD7QD9aQ34UCMcwfye8dC5YvJeXz2J3mmoy5S4',
    'RoYLttggWwa2st3KAGEjnPhsq4NPD5QwaNVyyR8pTz4',
    'SA1LFXr4os2P4VKGUyRv84uFfuUYgcQkFh2uA4SmRcr',
    'SANDCxXBbQhvbUqNtiLqKdFEY1uQhVo1UgUACaS4mXU',
    'SELEXm1aELCweknS2tsG6A4WivjVvgrTWn9doHNLj66',
    'SFundNVpuWk89g211WKUZGkuu4BsKSp7PbnmRsPZLos',
    'SLAY6uN1zZpXBTfbuDDCesNmM5D288xrz8uYvfS3n41',
    'SLNDCSGTEsA6KHpgR32MBt9UAurZnVSJGUtW2tRpdU2',
    'SPHERExTW7GaMgS4RN6MbghYvXU2REfFWHgpxMH1P69',
    'SQDS9iwyWvT2mQbSZzuNKGoxuBug5jRHouF6SuMRBkA',
    'SSmBEooM7RkmyuXxuKgAhTvhQZ36Z3G2WsmLGJKoQLY',
    'STaKesuXJH6UGRizuEVSWG1tyLu5ycKgWj3i1HUdvs5',
    'SWiz7QwnYPm61pWWUUkMhj4r5pZLP1SvYibdHcB2cov',
    'SaGAgdkowooXBrHihpmE8gsjf1dUG7n5SqnyJxYFnXJ',
    'SaV6UWBaE8M3kwMBfAhQ6Tmvd2qdJRm94NTwLqtoyGd',
    'Stakex4B2tpDHPWGvV1dninfiaYCGdakgTknpzPitLh',
    'Ste1115xFGdAYK5jaWA3dEFcUc1S5jEbVvD8e327zty',
    'SyndicAgdEphcy5xhAKZAomTYhcF8xhC7za2UD9xeug',
    'THWsLPufeq9LWs2H9vYPbtFwdxAHbQHvSbT6pztG8x1',
    'TREEir31FswHK7JZBS5oFQteS72dobi6inpmQha88dA',
    'TopjgY7N1fJdnW89S9fX6t7LF61nspgXGL1NpgAKhDG',
    'Tri1F8B6YtjkBztGCwBNSLEZib1EAqMUEUM7dTT7ZG3',
    'UNrgBLmc8JT6A3dxXY9DWeHvDezt2DZQbhg1KPQfqEL',
    'UPSCQNqdbiaqrQou9X9y8mr43ZHzvoNpKC26Mo7GubF',
    'UZBmptMjMSQEPKm4WyUkJeAuvZSqTuNK3cQCKFqJcXT',
    'VQwCCSfW3o5NDx7n5FBr9SoYiLXVgetstHvaWBvv2YH',
    'Va1idLRtYEtVFJFsvz8vtt1uCJgea4Q1zi2Rh3eraJh',
    'VicAQ3U2GjjAuF3tPCtEQZdZKnpAAxkr5Q3zjDKmdo7',
    'WUNoB9YQXmXXRcJsjY1G8PfVag5aAfnyGmFd6YwJVwp',
    'XAqHfPFsqTfAJHBRHAcEECkMSykXjkUj2Rta16Qshrk',
    'XkCriyrNwS3G4rzAXtG5B1nnvb5Ka1JtCku93VqeKAr',
    'Xoir1BnQX9TbEvon9HRbD8tkjcD9dorsxmNjZAV64Re',
    'YE11a5nVJtUNqsojkphYuWc7StqBzbCeFH6BjhAAUEV',
    'YuRBAsy9Stw1u46A8dMp7WQVBFweLP1PKuYibzYAMmQ',
    'aXiomFkk6VzXaBhPuhMqTLZZguCFzzbyP9LTtZ7ZHLQ',
    'adramSYKBv1yHoZTub4kepcmF5LybPxwyJcsz4fpfi7',
    'adre1Xia7ekGsEqNgHeFc7MYwkfzTQNeJgQmZ2agAKZ',
    'ana2y2YvQ3ZPMwm6qhnN3nJoUSiT3qx5Pvetkq9xcfY',
    'anza1rXDVhy1NfVNtsbT3kSBh2jgB1BGZUKuUibSAJd',
    'ark1hdnnfmusE24wGHkyVG1gdRCqfmXs9drasDAdABZ',
    'avnujiRNoSRe9PcET42DPKznyfYnb2LRaZAsqv6REZo',
    'axy3tCRL3wmFMVG4c69rYurcf4fXhBo2RcuBj9ADnJ4',
    'b1ueZK9bWTywN2587zsScyLTaH18wfRfN5W15XnkiqF',
    'bay3wXfJsu9ds1zQBoQQ4DUwFGs3NP6q4gca9WM5G1z',
    'bcZxRSozXDb61a77rxL6n9yumsbatqC7RFmZ8Xi5K8V',
    'bitHUmbKSQDTGoyoiW3BeqaGWdyV5sS3nYt5SduUHfb',
    'bkpk9KVsDRfrArzzmkJ9mPEvbXfQxczzQYR3QMGiR8Z',
    'bookoVmqw4QjVj5BbkFacouadx9M7816wyRkfM7A5Lo',
    'bxrAptB5ZpZBhoLedJpoGWY5hBjjt3zvVBr2323Rrq6',
    'c3rtoMCHSbFrLRTAdw4iRowKSn4BrDtvSPbuyJwkHwx',
    'capyS1jerxhFp1RehdWRG6kbWi8bnWF3fkEG2RGLsQf',
    'chdvWr6T14nqGRFD37KY36dsvhkCtDaufW5rpu3AfHe',
    'chopskqnudaeCTENWzUjfFCBSLcxprqbdMoCAucAwfb',
    'chrtyETASKQhsndRM9pr6qC3gAHG5MuRwCgXSNVqnJL',
    'ciTyjzN9iyobidMycjyqRRM7vXAHXkFzH3m8vEr6cQj',
    'cybi55ebub37HZW9YmRaLh59Lh3kqaLTsEBQwW6vFkC',
    'dcntruDNP5SEcGV4RxnsqXFURdDZGT3DTQv68Q8H7Vu',
    'dmMwc4RazLHkvDZYrWAfbHQ6cViAvNa5szCJKaiun8S',
    'dst2u7mXMyDvb14cSErRNA1mxH1d5VXbSXgZ3DKE9xH',
    'dxa6QFqLcByyHykLCAW5tv1VYNVQFV3v6oovM2h8inH',
    'dzBhD4wikyy7xqwiJvT49gdrKqWVjfs9M6cTssmRX8Y',
    'eyeYaqg9e2L6xw7YwsSLm27eWJfhLNAm6ETQm8TXNoK',
    'fdzip81euDS8jEZHx5H1mn27zGVMLzkgpQuzYRBfBYG',
    'fhsM2sxME8cHrrk3qvtMsRRDv5AoLFja7NjNnHeYZxe',
    'fishfishrD9BwrQQiAcG6YeYZVUYVJf3tb9QGQPMJqF',
    'forb5u56XgvzxiKfRt4FVNFQKJrd2LWAfNCsCqL6P7q',
    'gUvo3g5LfH4Pd8qnG7T6MPEFa5bPr8LhDdxDahwYqis',
    'gVALrRd3xq4D62KJNGDCpMMGz976w2x1Vo79mSNn4bh',
    'gangtCrQg5RmKf5yxvhvZThPugPX58pDSdQ5UuS26vN',
    'gojir4WnhS7VS1JdbnanJMzaMfr4UD7KeX1ixWAHEmw',
    'gotasRuLTuJNZDtLHmaDJpEUjCWZqkHcuwbLhkgCwCX',
    'gridqZmeBcsUKT2Mv4M9YFHFN3tVLFb2TCtTcLD1cAd',
    'grptonHnt7YSmJokGK9TJJTBXDT8ca4LSWMHCCfzzPa',
    'h3ZXAE168mNxsszYYrUfkMVSCWx6DU2Uvrx97Kb1Nch',
    'hnhCMmnrmod4rcyc3QRKkLEC9XnPTvYJ2gBvjgFiV4o',
    'huinBRP3muBuqZLMW8ARjdn4mBnEmFFcxiBzrkQz553',
    'hxMhrsuGPDmkLJ4mTxEjyeMST3VGhTiwJvS9XgHwePj',
    'hy1oMaD3ViyJ8i6w1xjP79zAWBBaRd1zWdTW8zYXnwu',
    'icex1C6pnZxznQWiHZZANjGU8nZ8kNquFnjyY7XXrXE',
    'idCE5k2BtTpwXdwAC7Var1enT9reut9fWECcxQP7LY7',
    'inWVrrYJ38VihdE62LXNQvgV5CeRrdKEXpNtXLyqUWD',
    'jagBNeXYncnn1hzwSq1JJ16XhWTgQ7DCFVqndSJZ6vT',
    'jntr1vkzvSujfckGR6ANmFmirVoPBMNr5XJGKP5uDQA',
    'juigBT2qetpYpf1iwgjaiWTjryKkY3uUTVAnRFKkqY6',
    'kom1oNHyyt84XLGVfi5Jo1qkVkU5xG1sBxPG19rWknE',
    'krakeNd6ednDPEXxHAmoBs1qKVM8kLg79PvWF2mhXV1',
    'kyzzzgRymGpePUsLyr48kQHt53kh5CSfRH1qfvz1xgj',
    'mALL2W6DUgDDtcyurC9v5YTF2CMMeuRwPBkf6tEoG3y',
    'mD1afZhSisoXfJLT8nYwSFANqjr1KPoDUEpYTEfFX1e',
    'mXv18ov8qCiQGs3ieoen981LdgZzYJjJak6reK6fpNC',
    'mastWEbKEMjvBCd1uaUBpNjWcfSPhXMWnH9tTrgzn1g',
    'mds1WWedpezW3qvgML4WgP341jZksYAy5SbMLwjP5KC',
    'mds2fZEpJP688PqJHvfLxGyf2VFrcNkvjuUxNYCwjrq',
    'mds3Df1ieBonG2qS8ZoKTqshq5MgTUNfZgc78cjiCdq',
    'mds4GEuiSgQRqveGyktWpETBFCb4AS2wDnhqwLHcT6Z',
    'meshRrDTME9cL2FSQ9E56EncfkZ7vL8apwcCFsw3o6Y',
    'mineL1YNwcRnxN93B2sX6q22R11WfRqxnY4NBV8KfFY',
    'mint13XHZSSxtgHuTSM9qPDEJSbWktpmpM4CZxeLB8f',
    'mrgn28BhocwdAUEenen3Sw2MR9cPKDpLkDvzDdR7DBD',
    'mrgn4sJJu5GBa5wbKyjuASzhyCifvcedGoLtpKjB3Wf',
    'mythxvB89eT3C1TKwwhsvdHfYq2aoCt2es8vLoDFYyk',
    'nSGZ3tv2UhskkPqiB666yDVj7PTi9qKgDqvjHyw5JgM',
    'nateKhsYkrVc992UuTfAhEEFQqr2zQfpGg9RafNkxdC',
    'nebu15XQKGpxzhhckADBX9PgvGN5qk9RRJCFLKc118w',
    'nodeEgRVkbYLAQePtMx2zCN7CGw7qRgzKMCBtjMfN1D',
    'novaeuhY2JH2WHhc9KVTHDx2cyJZdXJC6faf4CtARZn',
    'nymsHergYedT9CJMgtGMvqXUTGcbs5o3MiWTJUbqTGY',
    'oPaLtitM6cwpFVzP2rDhLsJLdY2vcbuZiJJyD1TFUKs',
    'odcvDWH5wHVKz9XtmGGxTj5ZsmawTjCCty3nyBKDGzS',
    'omeg2wsojzB7tfyAxsFhp8npxHL8yxVnaf51poXCwSd',
    'pSoLoZx55zZz61gjxSTwHtwTg4yTwdm7ruBmyjbYgT2',
    'parafiUS6h6oLhCFwhjvEmQJKw8pF1iXsxMJdTq46dS',
    'peNgUgnzs1jGogUPW8SThXMvzNpzKSNf3om78xVPAYx',
    'phz1CRbEsCtFCh2Ro5tjyu588VU1WPMwW9BJS9yFNn2',
    'pineXRUnbaLNFMxaM3zBmFfTiKgQMGqT9jYHXZWq2Fw',
    'pitch9cMruwjDtAnisNS4mwZUPhMsBztNEGu2weMg55',
    'popscoyTKVksa4TyTXw488b3vvFxM7qQEyTBeMQopKu',
    'ppppoqHcHVzigV6SK4856BAsNxhTAi32hqQQWrziyHE',
    'privaEdSEmnMPGPoQACUkcDGkFBbTArVvsEGd7C5wUM',
    'prt1st4RSxAt32ams4zsXCe1kavzmKeoR7eh1sdYRXW',
    'puffinQSvKFriPbyE5atyx1ptfnyytovbzxybr1jsyy',
    'q9XWcZ7T1wP4bW9SB4XgNNwjnFEJ982nE8aVbbNuwot',
    'qZMH9GWnnBkx7aM1h98iKSv2Lz5N78nwNSocAxDQrbP',
    'radM7PKUpZwJ9bYPAJ7V8FXHeUmH1zim6iaXUKkftP9',
    'rapXHroUoGG3KvZ3qwjvGMdA7siWXwXpiNC1bYarvSC',
    'revtecFsGSRCdF29atQvchSXrjwBesA9vSisD4fyH5K',
    'rsbp8zMHbGCpLoRktmsjspYv77VcjxAzH1KxPCD9BiU',
    'rssaJ2iKcE9QWsFYRZr8Q66TQh5bRk9DxYrzxGMzWQr',
    'sCANXAaS1a7yB8jz3USvGNLfd8DSc9r7TNzNSKKPkfY',
    'sTEAKPk59EtPPbixCweyv6oRLNCDEE8pnnef6gUfbiW',
    'sTEVErNNwF2qPnV6DuNPkWpEyCt4UU6k2Y3Hyn7WUFu',
    'sTepQGoReJq2tBKStL19DT6nnGHcGiAvFjyYaokLyuM',
    'sZAqxCSN5kkVfG2s65Bje4jzCkD2aLyk21qU95PMf2Y',
    'sbidYi7fbif6qNsMpwBKvyF5DKcLCbjaegpADsKqNux',
    'scb1Z7du8NVSaHFXsafSjRdXr6xBjWR3iugikL739Y1',
    'scb2TYPmwHgKxXJaJNq6gHKwYkVyLKx58hz9RbCKZZR',
    'sce1oTWYVXv7a7Hy2skxREozs5nwkQ4wDT8XJSi5tgE',
    'sce2zXNjLpPMcSCATTrLiQhAAvHNNMKypTFVtg2H37U',
    'sce3TfT81rxYYcdbP1kBFMcTK3ZBc8hvHVeXD6WLSzE',
    'scs1NCSTafrUX6RBx113B9YDCepo1QdEzU8WwEkf25i',
    'scs2Ra91pMbvqFAP7uitrN5U25SoyBTqZgBbhpVMJko',
    'sfvTq7ojrEc5WdXcHijz676eX1pc5MgoLxbkYSdRDAB',
    'shftkxnsXmqAkmLgz9Mn7bNB5Fr6mKgFc58kFHfVikj',
    'simpRo1FrQYGa1moicfgnPDp6KyE38d4gYrZzhjXYJb',
    'soLStaCk5TiGCpeLKa9Fvv6f5JQGMa6S3uhLh826e9N',
    'sp1mwUBiVzQPaNQoMrfSNYYfxViFrLDiBXs2pc4kG3k',
    'spcti6GQVvinbtHU9UAkbXhjTcBJaba1NVx4tmK4M5F',
    'spur5CDwBvTZszvy1ozGjRc1x2TuDWo3VF4jrq7zgvD',
    'ssx2rHZNVy6J1mbFjBdmnF244kbKf46SDwokjuhb477',
    'stacheBmGG5zMKuetUevAbc4m4dLbve1VPcpSur3voH',
    'svsD6T44XJnuXQWB15sy1pBxxruzrFy8rR7gXy8Jsj3',
    't23p8aBQN6P6tziMuN5XPmzqVRrip9oes7KuQwSmate',
    'te1ee9rGf369wxYQkuxkvuvMuTJ9cksgZySmNUF8rNY',
    'tkmaiSoZ3F8MofkQBVWG6JYSCzyN6ioe7ReYXohx3WJ',
    'uEhHSnCXvWgtgvVaYscPHjG13G3peMmngQQ2ghC54i3',
    'vALigXFg9wnnhVHN16vNxHxXtAXiBv5QjAE6udoniBY',
    'vahMVcSS3v6uwyFormV7FDAUbQSHwmy6vUedp1P7L42',
    'vaoJKVZYPAsqc52T2nNQhABR1gU6Cy2koDKfCQaEiva',
    'vnd1Ps8w3fsi54qUMJxBhUWARES34Qw7JQXDZxvbysd',
    'vu1sGn2f1Xim6voHNLt4nLn38zNkYdLasU7hEr1TC2D',
    'xLabscif2DLnYg39rQThqi7A9E45L9qiysRZhmZ1ARE',
    'yJeahQNRHNWtL9Z1SqPX3SBwTYXr5ECMYYVK4uYVwxt',
    'zeroT6PTAEjipvZuACTh1mbGCqTHgA6i1ped9DcuidX',
];

const logVoteAccountsForSmt = async () => {
    const voteAccounts = await connection.getVoteAccounts();

    const identityToVote = new Map<string, string>();
    for (const account of [...voteAccounts.current, ...voteAccounts.delinquent]) {
        identityToVote.set(account.nodePubkey, account.votePubkey);
    }

    let found = 0;
    for (const identity of smt) {
        const voteAccount = identityToVote.get(identity);
        if (voteAccount) {
            console.log(`'${voteAccount}',`);
            found++;
        } else {
            console.warn(`No vote account for identity ${identity}`);
        }
    }
    console.log(`Resolved ${found}/${smt.length} vote accounts`);
};

(async () => {
    await logVoteAccountsForSmt();
})();

const getApiUrl = (validator: string) => {
    return `https://api.validators.svt.one/validators-history/history?network=mainnet&vote_id=${validator}&epoch_count=16&epoch_from=996`;
};

const readUniqueVoteAccounts = (): string[] => {
    const raw = readFileSync(VAL_STATS2_CSV_PATH, "utf8");
    const records = parse(raw, {
        columns: true,
        skip_empty_lines: true,
    }) as Record<string, string>[];

    const voteAccounts = new Set<string>();
    for (const record of records) {
        const voteAccount = record.vote_account?.trim();
        if (voteAccount) voteAccounts.add(voteAccount);
    }
    return [...voteAccounts];
};

/** vote_account -> identity_account (first seen in val_stats2.csv). */
const readVoteToIdentityMap = (): Map<string, string> => {
    const raw = readFileSync(VAL_STATS2_CSV_PATH, "utf8");
    const records = parse(raw, {
        columns: true,
        skip_empty_lines: true,
    }) as Record<string, string>[];

    const map = new Map<string, string>();
    for (const record of records) {
        const voteAccount = record.vote_account?.trim();
        const identityAccount = record.identity_account?.trim();
        if (voteAccount && identityAccount && !map.has(voteAccount)) {
            map.set(voteAccount, identityAccount);
        }
    }
    return map;
};

/** leader (identity) -> { name, client } from the Firedancer report CSV. */
const readFiredancerMeta = (): Map<string, { name: string; client: string }> => {
    const raw = readFileSync(FIREDCANCER_CSV_PATH, "utf8");
    const records = parse(raw, {
        columns: true,
        skip_empty_lines: true,
    }) as Record<string, string>[];

    const map = new Map<string, { name: string; client: string }>();
    for (const record of records) {
        const leader = record.leader?.trim();
        if (!leader) continue;
        map.set(leader, {
            name: record.name?.trim() ?? "",
            client: record.client?.trim() ?? "",
        });
    }
    return map;
};

const fetchValidatorInfo = async (validator: string): Promise<StvApiResponse[]> => {
    const response = await fetch(getApiUrl(validator));

    if (!response.ok) {
        throw new Error(`Failed to fetch validator: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as { data: Record<string, unknown>[] };
    const rows = json.data ?? [];

    return rows.map((row) => ({
        validatorId: String(row.validatorId ?? ""),
        voteId: String(row.voteId ?? ""),
        commissionReward: toLamports(row.commissionReward as string | number),
        votingReward: toLamports(row.votingReward as string | number),
        votingFee: toLamports(row.votingFee as string | number),
        votingCompensation: toLamports(row.votingCompensation as string | number),
        jitoReward: toLamports(row.jitoReward as string | number),
        epoch: Number(row.epoch),
        mevCommission: Number(row.mevCommission ?? row.mevComission ?? 0),
        totalStake: toLamports(row.totalStake as string | number),
    }));
};

/**
 * Total SOL for an epoch:
 *   leader reward + inflation rewards + jito reward − voting fee + voting compensation
 */
const calculateEpochEarnings = (
    voteAccount: string,
    identityAccount: string,
    name: string,
    client: string,
    rows: StvApiResponse[],
): EpochEarningRow[] => {
    return rows
        .map((row) => {
            const leaderRewardSol = lamportsToSol(row.votingReward);
            const inflationRewardsSol = lamportsToSol(row.commissionReward);
            const jitoRewardSol = lamportsToSol(row.jitoReward);
            const votingFeeSol = -lamportsToSol(row.votingFee);
            const votingCompensationSol = lamportsToSol(row.votingCompensation);
            const totalSol =
                leaderRewardSol +
                inflationRewardsSol +
                jitoRewardSol +
                votingFeeSol +
                votingCompensationSol;
            const solPrice = SOL_PRICE_BY_EPOCH[row.epoch] ?? 0;

            return {
                name,
                client,
                identity_account: identityAccount,
                vote_account: voteAccount,
                epoch: row.epoch,
                dates: EPOCH_DATES[row.epoch] ?? "",
                leader_reward_sol: leaderRewardSol,
                inflation_rewards_sol: inflationRewardsSol,
                jito_reward_sol: jitoRewardSol,
                voting_fee_sol: votingFeeSol,
                voting_compensation_sol: votingCompensationSol,
                total_sol: totalSol,
                total_usd: totalSol * solPrice,
                sol_price: solPrice,
                stake_in_epoch: lamportsToSol(row.totalStake),
                commission: 0,
            };
        })
        .sort((a, b) => a.epoch - b.epoch);
};

const writeValStats3 = (rows: EpochEarningRow[]) => {
    writeFileSync(
        VAL_STATS3_CSV_PATH,
        stringify(rows, {
            header: true,
            columns: [
                "name",
                "client",
                "identity_account",
                "vote_account",
                "epoch",
                "dates",
                "leader_reward_sol",
                "inflation_rewards_sol",
                "jito_reward_sol",
                "voting_fee_sol",
                "voting_compensation_sol",
                "total_sol",
                "total_usd",
                "sol_price",
                "stake_in_epoch",
                "commission",
            ],
        }),
    );
    console.log(`Wrote ${rows.length} rows to ${VAL_STATS3_CSV_PATH}`);
};

export const validateValEarnings = async () => {
    const voteAccounts = readUniqueVoteAccounts();
    const voteToIdentity = readVoteToIdentityMap();
    const firedancerMeta = readFiredancerMeta();

    console.log(`Found ${voteAccounts.length} unique vote accounts in val_stats2.csv`);

    const earnings: EpochEarningRow[] = [];

    for (let i = 0; i < voteAccounts.length; i++) {
        const voteAccount = voteAccounts[i]!;
        const identityAccount = voteToIdentity.get(voteAccount) ?? "";
        const meta = firedancerMeta.get(identityAccount) ?? { name: "", client: "" };

        try {
            const data = await fetchValidatorInfo(voteAccount);
            earnings.push(
                ...calculateEpochEarnings(
                    voteAccount,
                    identityAccount,
                    meta.name,
                    meta.client,
                    data,
                ),
            );
            console.log(
                `[${i + 1}/${voteAccounts.length}] ${voteAccount}: ${data.length} epochs`,
            );
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            console.warn(
                `[${i + 1}/${voteAccounts.length}] ${voteAccount}: failed — ${reason}`,
            );
        }

        if (i < voteAccounts.length - 1) {
            await sleep(REQUEST_DELAY_MS);
        }
    }

    writeValStats3(earnings);
};

// if (import.meta.url === `file://${process.argv[1]}`) {
//     validateValEarnings().catch((err) => {
//         console.error(err);
//         process.exit(1);
//     });
// }
