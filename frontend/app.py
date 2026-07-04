"""Interactive dashboard for Solana validator earnings (val_stats3).

Reads ../report/val_stats3.csv (one row per validator per epoch) and shows:
  1. Stake vs. Earning       (scatter, per validator over the selected range)
  2. Client vs. Earning      (aggregated bar)
  3. Accumulated table       (one row per validator identity; sums for all
                              monetary columns, average for stake_in_epoch)

Per-epoch earning comes straight from the SVT API validation:
    total_sol = leader + commission + jito - voting fee + voting compensation
    total_usd = total_sol * per-epoch SOL price

Run with:
    streamlit run frontend/app.py
"""

from pathlib import Path

import pandas as pd
import plotly.express as px
import streamlit as st

DEFAULT_CSV_PATH = Path(__file__).resolve().parent.parent / "report" / "val_stats3.csv"

# Per-epoch columns that are summed when accumulating per validator.
SUM_COLS = [
    "leader_reward_sol",
    "commission_sol",
    "jito_reward_sol",
    "voting_fee_sol",
    "voting_compensation_sol",
    "total_sol",
    "total_usd",
]


@st.cache_data
def load_data(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)

    numeric_cols = SUM_COLS + ["epoch", "sol_price", "stake_in_epoch"]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)

    df["name"] = df["name"].fillna("")
    df["client"] = df["client"].fillna("").replace("", "Unknown")
    df["label"] = df.apply(
        lambda r: r["name"] if str(r["name"]).strip() else r["identity_account"],
        axis=1,
    )
    return df


@st.cache_data
def epoch_dates_map(df: pd.DataFrame) -> dict[int, str]:
    """epoch -> date range string, e.g. 981 -> '02.06.2026 - 04.06.2026'."""
    pairs = df[["epoch", "dates"]].dropna().drop_duplicates("epoch")
    return dict(zip(pairs["epoch"].astype(int), pairs["dates"].astype(str)))


def aggregate_per_identity(df: pd.DataFrame) -> pd.DataFrame:
    """One row per identity: sums for monetary columns, average stake."""

    def first_non_empty(series: pd.Series) -> str:
        for value in series:
            if str(value).strip():
                return str(value)
        return ""

    grouped = (
        df.groupby("identity_account", as_index=False)
        .agg(
            name=("name", first_non_empty),
            client=("client", first_non_empty),
            vote_account=("vote_account", "first"),
            leader_reward_sol=("leader_reward_sol", "sum"),
            commission_sol=("commission_sol", "sum"),
            jito_reward_sol=("jito_reward_sol", "sum"),
            voting_fee_sol=("voting_fee_sol", "sum"),
            voting_compensation_sol=("voting_compensation_sol", "sum"),
            total_sol=("total_sol", "sum"),
            total_usd=("total_usd", "sum"),
            avg_stake_in_epoch=("stake_in_epoch", "mean"),
            epochs=("epoch", "nunique"),
        )
    )
    grouped["label"] = grouped.apply(
        lambda r: r["name"] if str(r["name"]).strip() else r["identity_account"],
        axis=1,
    )
    return grouped


def main() -> None:
    st.set_page_config(page_title="Validator Earnings", page_icon="📊", layout="wide")

    # ---- Sidebar: data source & display options ----------------------------
    with st.sidebar:
        st.header("Data & display")
        csv_path = Path(st.text_input("CSV path", value=str(DEFAULT_CSV_PATH)))
        if not csv_path.exists():
            st.error(f"CSV not found at: {csv_path}")
            st.stop()

        earning_unit = st.radio(
            "Earnings unit", options=["SOL", "USD"], index=0, horizontal=True
        )
        log_x = st.checkbox("Log scale: stake (x)", value=True)
        log_y = st.checkbox("Log scale: earning (y)", value=False)
        client_agg = st.selectbox(
            "Client aggregation", options=["sum", "mean", "median"], index=0
        )

    raw = load_data(csv_path)
    earning_col = "total_sol" if earning_unit == "SOL" else "total_usd"
    unit_suffix = "SOL" if earning_unit == "SOL" else "USD"

    st.title("Solana Validator Earnings")
    st.caption(
        "Per-epoch earning = leader + commission + jito − voting fee + voting "
        "compensation (from val_stats3). Stake shown is the average "
        "stake_in_epoch over the selected range."
    )

    # ---- Epoch / date range -------------------------------------------------
    dates_by_epoch = epoch_dates_map(raw)
    epochs = sorted(dates_by_epoch)

    st.subheader("Date range")
    epoch_start, epoch_end = st.select_slider(
        "Period",
        options=epochs,
        value=(epochs[0], epochs[-1]),
        format_func=lambda e: dates_by_epoch[e],
    )
    st.caption(
        f"{dates_by_epoch[epoch_start]} → {dates_by_epoch[epoch_end]} · "
        f"{epoch_end - epoch_start + 1} epochs"
    )

    in_range = raw[(raw["epoch"] >= epoch_start) & (raw["epoch"] <= epoch_end)]
    if in_range.empty:
        st.warning("No data in the selected epoch range.")
        st.stop()

    aggregated = aggregate_per_identity(in_range)

    # ---- Filters ------------------------------------------------------------
    st.subheader("Filters")

    fcol1, fcol2 = st.columns(2)
    with fcol1:
        name_options = sorted(
            n for n in aggregated["label"].unique() if str(n).strip()
        )
        selected_names = st.multiselect(
            "Validator (name or identity)",
            options=name_options,
            placeholder="All validators — type to search…",
        )
    with fcol2:
        client_options = sorted(aggregated["client"].unique())
        selected_clients = st.multiselect(
            "Client",
            options=client_options,
            placeholder="All clients — type to search…",
        )

    stake_max = float(aggregated["avg_stake_in_epoch"].max())
    scol1, scol2 = st.columns([3, 1])
    with scol2:
        quick_1m = st.checkbox("Stake ≥ 1,000,000", value=False, help="Quick preset (SOL)")
    with scol1:
        min_stake = st.number_input(
            "Minimum avg stake (SOL)",
            min_value=0.0,
            max_value=stake_max,
            value=min(1_000_000.0 if quick_1m else 0.0, stake_max),
            step=max(stake_max / 100, 1.0),
            format="%.2f",
        )

    mask = aggregated["avg_stake_in_epoch"] >= min_stake
    if selected_names:
        mask &= aggregated["label"].isin(selected_names)
    if selected_clients:
        mask &= aggregated["client"].isin(selected_clients)

    df = aggregated[mask].copy()
    if df.empty:
        st.warning("No validators match the current filters.")
        st.stop()

    df["earning"] = df[earning_col]

    # ---- Insight metrics ----------------------------------------------------
    st.subheader("Insights")

    client_totals = df.groupby("client")["earning"].sum()
    top_client = client_totals.idxmax()
    top_validator = df.loc[df["earning"].idxmax()]
    # Earnings yield: how much a validator earns per SOL staked, annualized nothing —
    # just the raw ratio over the range, useful to compare big vs small stakes.
    total_stake = df["avg_stake_in_epoch"].sum()
    earning_per_msol = df["earning"].sum() / total_stake * 1_000_000 if total_stake else 0
    stake_earning_corr = df["avg_stake_in_epoch"].corr(df["earning"])

    m1, m2, m3, m4 = st.columns(4)
    m1.metric("Validators", f"{len(df):,}")
    m2.metric(f"Total earnings ({unit_suffix})", f"{df['earning'].sum():,.2f}")
    m3.metric(f"Avg earnings ({unit_suffix})", f"{df['earning'].mean():,.2f}")
    m4.metric(f"Median earnings ({unit_suffix})", f"{df['earning'].median():,.2f}")

    m5, m6, m7, m8 = st.columns(4)
    m5.metric(
        "Most earning client",
        top_client,
        delta=f"{client_totals.max():,.0f} {unit_suffix}",
        delta_color="off",
    )
    m6.metric(
        "Top validator",
        str(top_validator["label"])[:24],
        delta=f"{top_validator['earning']:,.0f} {unit_suffix}",
        delta_color="off",
    )
    m7.metric(f"Earnings per 1M SOL staked ({unit_suffix})", f"{earning_per_msol:,.2f}")
    m8.metric("Stake ↔ earning correlation", f"{stake_earning_corr:.3f}")

    # ---- Graph 1: stake vs earning -------------------------------------------
    st.subheader("Stake vs. Earning")
    scatter = px.scatter(
        df,
        x="avg_stake_in_epoch",
        y="earning",
        color="client",
        hover_name="label",
        hover_data={
            "identity_account": True,
            "epochs": True,
            "avg_stake_in_epoch": ":,.2f",
            "earning": ":,.2f",
        },
        labels={
            "avg_stake_in_epoch": "Avg stake (SOL)",
            "earning": f"Earnings ({unit_suffix})",
            "client": "Client",
        },
        log_x=log_x,
        log_y=log_y,
        height=600,
    )
    scatter.update_traces(marker=dict(size=8, opacity=0.7))
    st.plotly_chart(scatter, use_container_width=True)

    # ---- Graph 2: client vs earnings -----------------------------------------
    st.subheader("Client vs. Earnings")
    per_client = (
        df.groupby("client")["earning"]
        .agg(client_agg)
        .reset_index()
        .sort_values("earning", ascending=False)
    )
    counts = df.groupby("client").size().rename("validators").reset_index()
    per_client = per_client.merge(counts, on="client")

    bar = px.bar(
        per_client,
        x="client",
        y="earning",
        color="client",
        hover_data={"validators": True, "earning": ":,.2f"},
        labels={
            "earning": f"{client_agg.capitalize()} earnings ({unit_suffix})",
            "client": "Client",
        },
        height=500,
    )
    bar.update_layout(showlegend=False, xaxis={"categoryorder": "total descending"})
    st.plotly_chart(bar, use_container_width=True)

    # ---- Accumulated table ----------------------------------------------------
    st.subheader("Accumulated per validator")
    table = df[
        [
            "name",
            "client",
            "identity_account",
            "avg_stake_in_epoch",
            "epochs",
            "leader_reward_sol",
            "commission_sol",
            "jito_reward_sol",
            "voting_fee_sol",
            "voting_compensation_sol",
            "total_sol",
            "total_usd",
        ]
    ].sort_values(earning_col, ascending=False)

    st.caption(
        f"{len(table):,} validators · {dates_by_epoch[epoch_start]} → "
        f"{dates_by_epoch[epoch_end]} · "
        "monetary columns are accumulated sums; avg_stake_in_epoch is the "
        "average across the validator's epochs in range."
    )
    st.dataframe(table, use_container_width=True, hide_index=True)


if __name__ == "__main__":
    main()
