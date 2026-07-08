"""Interactive dashboard for Solana validator earnings (val_stats3).

Reads ../report/val_stats3.csv (one row per validator per epoch) and shows:
  1. Stake vs. Earning       (scatter, per validator over the selected range)
  2. Client vs. Earnings      (aggregated bar)
  3. Earnings vs. Dates       (time series over epoch date ranges)
  4. Client & commission      (Jito/BAM mix and changes over epochs 981–996)
  5. Accumulated table        (one row per validator identity)

Run with:
    streamlit run frontend/app.py
"""

from pathlib import Path

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import streamlit as st

DEFAULT_CSV_PATH = Path(__file__).resolve().parent.parent / "report" / "val_stats3.csv"
STORED_EPOCH_MIN = 981
STORED_EPOCH_MAX = 996

CLIENT_TYPE_ORDER = ["Jito + BAM", "Jito", "BAM", "Neither", "Unknown"]
CLIENT_TYPE_COLORS = {
    "Jito + BAM": "#7b2cbf",
    "Jito": "#2a9d8f",
    "BAM": "#e76f51",
    "Neither": "#adb5bd",
    "Unknown": "#6c757d",
}

SUM_COLS = [
    "leader_reward_sol",
    "inflation_rewards_sol",
    "jito_reward_sol",
    "voting_fee_sol",
    "voting_compensation_sol",
    "total_sol",
    "total_usd",
]


@st.cache_data
def load_data(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)

    numeric_cols = SUM_COLS + ["epoch", "sol_price", "stake_in_epoch", "commission"]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)

    df["name"] = df["name"].fillna("")
    df["client"] = df["client"].fillna("").replace("", "Unknown")
    df["label"] = df.apply(
        lambda r: r["name"] if str(r["name"]).strip() else r["identity_account"],
        axis=1,
    )
    df["period_start"] = df["dates"].map(parse_period_start)

    for col in ("is_jito", "is_bam"):
        if col in df.columns:
            df[col] = df[col].fillna("").astype(str).str.strip().str.lower()
        else:
            df[col] = ""

    df["is_jito_bool"] = df["is_jito"].map(parse_optional_bool)
    df["is_bam_bool"] = df["is_bam"].map(parse_optional_bool)
    df["client_type"] = df.apply(classify_client_type, axis=1)
    return df


@st.cache_data
def epoch_dates_map(df: pd.DataFrame) -> dict[int, str]:
    pairs = df[["epoch", "dates"]].dropna().drop_duplicates("epoch")
    return dict(zip(pairs["epoch"].astype(int), pairs["dates"].astype(str)))


def parse_optional_bool(value: object) -> bool | None:
    text = str(value).strip().lower()
    if text == "true":
        return True
    if text == "false":
        return False
    return None


def classify_client_type(row: pd.Series) -> str:
    is_jito = row["is_jito_bool"]
    is_bam = row["is_bam_bool"]
    if is_jito is None:
        return "Unknown"
    if is_jito and is_bam:
        return "Jito + BAM"
    if is_jito:
        return "Jito"
    if is_bam:
        return "BAM"
    return "Neither"


def parse_period_start(dates: str) -> pd.Timestamp:
    """First day of an epoch date range, e.g. '02.06.2026 - 04.06.2026'."""
    start_str = str(dates).split(" - ")[0].strip()
    return pd.to_datetime(start_str, format="%d.%m.%Y")


def aggregate_per_identity(df: pd.DataFrame) -> pd.DataFrame:
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
            inflation_rewards_sol=("inflation_rewards_sol", "sum"),
            jito_reward_sol=("jito_reward_sol", "sum"),
            voting_fee_sol=("voting_fee_sol", "sum"),
            voting_compensation_sol=("voting_compensation_sol", "sum"),
            total_sol=("total_sol", "sum"),
            total_usd=("total_usd", "sum"),
            commission=("commission", "max"),
            avg_stake_in_epoch=("stake_in_epoch", "mean"),
            epochs=("epoch", "nunique"),
        )
    )
    grouped["label"] = grouped.apply(
        lambda r: r["name"] if str(r["name"]).strip() else r["identity_account"],
        axis=1,
    )
    return grouped


def client_mix_by_epoch(epoch_df: pd.DataFrame) -> pd.DataFrame:
    """Count validators in each Jito/BAM client bucket per epoch."""
    counts = (
        epoch_df.groupby(["epoch", "dates", "period_start", "client_type"], as_index=False)
        .size()
        .rename(columns={"size": "validators"})
    )
    counts["client_type"] = pd.Categorical(
        counts["client_type"], categories=CLIENT_TYPE_ORDER, ordered=True
    )
    return counts.sort_values(["period_start", "client_type"])


def commission_stats_by_epoch(epoch_df: pd.DataFrame) -> pd.DataFrame:
    """Median/mean commission per epoch for the filtered validator set."""
    return (
        epoch_df.groupby(["epoch", "dates", "period_start"], as_index=False)["commission"]
        .agg(median_commission="median", mean_commission="mean", validators="count")
        .sort_values("period_start")
    )


def epoch_transition_changes(epoch_df: pd.DataFrame) -> pd.DataFrame:
    """Validators whose is_jito, is_bam, or commission changed vs. the prior epoch."""
    if epoch_df.empty:
        return pd.DataFrame(
            columns=[
                "epoch",
                "dates",
                "period_start",
                "jito_changes",
                "bam_changes",
                "commission_changes",
            ]
        )

    rows: list[dict[str, object]] = []
    for vote_account, group in epoch_df.groupby("vote_account"):
        ordered = group.sort_values("epoch")
        previous = None
        for _, current in ordered.iterrows():
            if previous is not None:
                rows.append(
                    {
                        "epoch": int(current["epoch"]),
                        "dates": current["dates"],
                        "period_start": current["period_start"],
                        "jito_changed": current["is_jito_bool"] != previous["is_jito_bool"],
                        "bam_changed": current["is_bam_bool"] != previous["is_bam_bool"],
                        "commission_changed": current["commission"] != previous["commission"],
                    }
                )
            previous = current

    if not rows:
        return pd.DataFrame(
            columns=[
                "epoch",
                "dates",
                "period_start",
                "jito_changes",
                "bam_changes",
                "commission_changes",
            ]
        )

    changes = pd.DataFrame(rows)
    return (
        changes.groupby(["epoch", "dates", "period_start"], as_index=False)
        .agg(
            jito_changes=("jito_changed", "sum"),
            bam_changes=("bam_changed", "sum"),
            commission_changes=("commission_changed", "sum"),
        )
        .sort_values("period_start")
    )


def validators_with_any_change(epoch_df: pd.DataFrame) -> pd.DataFrame:
    """One row per vote account that changed Jito/BAM status or commission in range."""
    summaries: list[dict[str, object]] = []
    for vote_account, group in epoch_df.groupby("vote_account"):
        ordered = group.sort_values("epoch")
        jito_values = ordered["is_jito_bool"].dropna().unique()
        bam_values = ordered["is_bam_bool"].dropna().unique()
        commission_values = ordered["commission"].unique()
        changed = (
            len(jito_values) > 1
            or len(bam_values) > 1
            or len(commission_values) > 1
        )
        if not changed:
            continue

        label = ordered["label"].iloc[0]
        summaries.append(
            {
                "vote_account": vote_account,
                "label": label,
                "client": ordered["client"].iloc[0],
                "epochs": int(ordered["epoch"].nunique()),
                "jito_changed": len(jito_values) > 1,
                "bam_changed": len(bam_values) > 1,
                "commission_changed": len(commission_values) > 1,
                "commission_min": float(ordered["commission"].min()),
                "commission_max": float(ordered["commission"].max()),
            }
        )

    if not summaries:
        return pd.DataFrame(
            columns=[
                "vote_account",
                "label",
                "client",
                "epochs",
                "jito_changed",
                "bam_changed",
                "commission_changed",
                "commission_min",
                "commission_max",
            ]
        )

    return pd.DataFrame(summaries).sort_values("label")


def aggregate_earnings_by_date(epoch_df: pd.DataFrame, earning_col: str) -> pd.DataFrame:
    """Sum earnings per epoch date range across filtered validators."""
    return (
        epoch_df.groupby(["epoch", "dates", "period_start"], as_index=False)[earning_col]
        .sum()
        .rename(columns={earning_col: "earning"})
        .sort_values("period_start")
    )


def main() -> None:
    st.set_page_config(page_title="Validator Earnings", page_icon="📊", layout="wide")

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
        "Per-epoch earning = leader + inflation + jito − voting fee + voting "
        "compensation (from val_stats3)."
    )

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
        st.warning("No data in the selected date range.")
        st.stop()

    aggregated = aggregate_per_identity(in_range)

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
    filtered_epochs = in_range[in_range["identity_account"].isin(df["identity_account"])]

    # ---- Insights -----------------------------------------------------------
    st.subheader("Insights")

    client_totals = df.groupby("client")["earning"].sum()
    top_client = client_totals.idxmax()
    top_validator = df.loc[df["earning"].idxmax()]
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

    # ---- Graph 1: stake vs earning ------------------------------------------
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
    st.caption("One point per validator over the full selected date range.")
    st.plotly_chart(scatter, use_container_width=True)

    # ---- Graph 2: client vs earnings ----------------------------------------
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

    # ---- Graph 3: earnings vs dates -----------------------------------------
    st.subheader("Earnings vs. Dates")
    by_date = aggregate_earnings_by_date(filtered_epochs, earning_col)

    timeline = px.line(
        by_date,
        x="dates",
        y="earning",
        markers=True,
        labels={
            "dates": "Date",
            "earning": f"Total earnings ({unit_suffix})",
        },
        height=450,
    )
    timeline.update_layout(xaxis={"categoryorder": "array", "categoryarray": by_date["dates"].tolist()})
    st.caption(
        f"Total earnings across {len(df):,} filtered validators, summed per epoch date range."
    )
    st.plotly_chart(timeline, use_container_width=True)

    # ---- Graph 4: client flags & commission over epochs ---------------------
    st.subheader("Client & commission over time")
    st.caption(
        f"Jito/BAM flags (`is_jito`, `is_bam`) and commission per epoch "
        f"({STORED_EPOCH_MIN}–{STORED_EPOCH_MAX}). "
        "Transition counts compare each epoch to the validator's prior epoch in range."
    )

    client_epoch_df = filtered_epochs[
        (filtered_epochs["epoch"] >= STORED_EPOCH_MIN)
        & (filtered_epochs["epoch"] <= STORED_EPOCH_MAX)
    ].copy()
    if client_epoch_df.empty:
        st.info("No per-epoch client data for the selected filters in epochs 981–996.")
    else:
        change_table = validators_with_any_change(client_epoch_df)
        mix = client_mix_by_epoch(client_epoch_df)
        commission_trend = commission_stats_by_epoch(client_epoch_df)
        transitions = epoch_transition_changes(client_epoch_df)
        ordered_dates = (
            mix.sort_values("period_start")["dates"].drop_duplicates().tolist()
        )

        c1, c2, c3, c4 = st.columns(4)
        c1.metric(
            "Validators with Jito flag changes",
            f"{int(change_table['jito_changed'].sum()) if not change_table.empty else 0:,}",
        )
        c2.metric(
            "Validators with BAM flag changes",
            f"{int(change_table['bam_changed'].sum()) if not change_table.empty else 0:,}",
        )
        c3.metric(
            "Validators with commission changes",
            f"{int(change_table['commission_changed'].sum()) if not change_table.empty else 0:,}",
        )
        c4.metric(
            "Any client/commission change",
            f"{len(change_table):,}",
            help="Validators that changed is_jito, is_bam, or commission at least once.",
        )

        mix_chart = px.bar(
            mix,
            x="dates",
            y="validators",
            color="client_type",
            category_orders={"client_type": CLIENT_TYPE_ORDER},
            color_discrete_map=CLIENT_TYPE_COLORS,
            labels={
                "dates": "Epoch dates",
                "validators": "Validators",
                "client_type": "Client type",
            },
            height=420,
        )
        mix_chart.update_layout(
            barmode="stack",
            xaxis={"categoryorder": "array", "categoryarray": ordered_dates},
            legend_title_text="Client type",
        )
        st.plotly_chart(mix_chart, use_container_width=True)

        left, right = st.columns(2)
        with left:
            if transitions.empty:
                st.info("Need at least two epochs per validator to show transition counts.")
            else:
                transition_long = transitions.melt(
                    id_vars=["epoch", "dates", "period_start"],
                    value_vars=["jito_changes", "bam_changes", "commission_changes"],
                    var_name="change_type",
                    value_name="validators",
                )
                transition_long["change_type"] = transition_long["change_type"].map(
                    {
                        "jito_changes": "is_jito",
                        "bam_changes": "is_bam",
                        "commission_changes": "commission",
                    }
                )
                transition_chart = px.bar(
                    transition_long,
                    x="dates",
                    y="validators",
                    color="change_type",
                    barmode="group",
                    labels={
                        "dates": "Epoch dates",
                        "validators": "Validators changed",
                        "change_type": "Field",
                    },
                    height=380,
                )
                transition_chart.update_layout(
                    xaxis={"categoryorder": "array", "categoryarray": ordered_dates},
                    legend_title_text="Changed field",
                )
                st.markdown("**Epoch-over-epoch changes**")
                st.plotly_chart(transition_chart, use_container_width=True)

        with right:
            commission_chart = go.Figure()
            commission_chart.add_trace(
                go.Scatter(
                    x=commission_trend["dates"],
                    y=commission_trend["median_commission"],
                    mode="lines+markers",
                    name="Median commission",
                )
            )
            commission_chart.add_trace(
                go.Scatter(
                    x=commission_trend["dates"],
                    y=commission_trend["mean_commission"],
                    mode="lines+markers",
                    name="Mean commission",
                    line={"dash": "dash"},
                )
            )
            commission_chart.update_layout(
                title="Commission trend",
                xaxis={
                    "title": "Epoch dates",
                    "categoryorder": "array",
                    "categoryarray": ordered_dates,
                },
                yaxis={"title": "Commission (%)"},
                height=380,
                legend={"orientation": "h", "yanchor": "bottom", "y": 1.02, "x": 0},
            )
            st.plotly_chart(commission_chart, use_container_width=True)

        drilldown_options = change_table["label"].tolist()
        selected_drilldown = st.multiselect(
            "Drill down: validators with changes",
            options=drilldown_options,
            placeholder="Select up to 6 validators to compare trajectories…",
            max_selections=6,
        )
        if selected_drilldown:
            drilldown_df = client_epoch_df[
                client_epoch_df["label"].isin(selected_drilldown)
            ].sort_values(["label", "period_start"])
            trajectory = make_subplots(
                rows=2,
                cols=1,
                shared_xaxes=True,
                vertical_spacing=0.08,
                row_heights=[0.55, 0.45],
                subplot_titles=("Commission (%)", "Client flags"),
            )

            for label, group in drilldown_df.groupby("label"):
                trajectory.add_trace(
                    go.Scatter(
                        x=group["dates"],
                        y=group["commission"],
                        mode="lines+markers",
                        name=f"{label} · commission",
                        legendgroup=label,
                        showlegend=True,
                    ),
                    row=1,
                    col=1,
                )
                trajectory.add_trace(
                    go.Scatter(
                        x=group["dates"],
                        y=group["is_jito_bool"].map(
                            lambda value: 1 if value else 0 if value is False else None
                        ),
                        mode="lines+markers",
                        name=f"{label} · is_jito",
                        legendgroup=label,
                        showlegend=False,
                        line={"dash": "dot"},
                    ),
                    row=2,
                    col=1,
                )
                trajectory.add_trace(
                    go.Scatter(
                        x=group["dates"],
                        y=group["is_bam_bool"].map(
                            lambda value: 1 if value else 0 if value is False else None
                        ),
                        mode="lines+markers",
                        name=f"{label} · is_bam",
                        legendgroup=label,
                        showlegend=False,
                        line={"dash": "dash"},
                    ),
                    row=2,
                    col=1,
                )

            trajectory.update_yaxes(title_text="Commission (%)", row=1, col=1)
            trajectory.update_yaxes(
                title_text="Flag (1=true, 0=false)",
                tickvals=[0, 1],
                row=2,
                col=1,
            )
            trajectory.update_xaxes(
                categoryorder="array",
                categoryarray=ordered_dates,
                row=2,
                col=1,
            )
            trajectory.update_layout(height=620, legend={"orientation": "h"})
            st.plotly_chart(trajectory, use_container_width=True)

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
            "inflation_rewards_sol",
            "commission",
            "jito_reward_sol",
            "voting_fee_sol",
            "voting_compensation_sol",
            "total_sol",
            "total_usd",
        ]
    ].sort_values(earning_col, ascending=False)

    st.caption(
        f"{len(table):,} validators · {dates_by_epoch[epoch_start]} → "
        f"{dates_by_epoch[epoch_end]} · monetary columns are accumulated sums; "
        "avg_stake_in_epoch is the average across epochs in range."
    )
    st.dataframe(table, use_container_width=True, hide_index=True)


if __name__ == "__main__":
    main()
