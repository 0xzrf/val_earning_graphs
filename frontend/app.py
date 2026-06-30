"""Interactive dashboard for Solana validator earnings.

Reads ../report/val_stats.csv and visualizes:
  1. Stake vs. Earning   (scatter)
  2. Client vs. Earning   (aggregated bar + per-client distribution)

Earning is defined as:
    (blocks * (avgFees + avgTip) + inflationRewards) - (votes * 5000)

Run with:
    streamlit run frontend/app.py
"""

from pathlib import Path

import pandas as pd
import plotly.express as px
import streamlit as st

LAMPORTS_PER_SOL = 1_000_000_000
VOTE_FEE_LAMPORTS = 5_000

# val_stats.csv lives in ../report relative to this file.
DEFAULT_CSV_PATH = Path(__file__).resolve().parent.parent / "report" / "val_stats.csv"


@st.cache_data
def load_data(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)

    numeric_cols = [
        "blocks",
        "avgFees",
        "avgTip",
        "stake",
        "comission",
        "votes",
        "inflationRewards",
    ]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)

    df["client"] = df["client"].fillna("").replace("", "Unknown")

    # Earning in lamports.
    df["earning"] = (
        df["blocks"] * (df["avgFees"] + df["avgTip"])
        + df["inflationRewards"]
        - df["votes"] * VOTE_FEE_LAMPORTS
    )

    return df


def to_unit(series: pd.Series, unit: str) -> pd.Series:
    if unit == "SOL":
        return series / LAMPORTS_PER_SOL
    return series


def main() -> None:
    st.set_page_config(page_title="Validator Earnings", page_icon="📊", layout="wide")
    st.title("Solana Validator Earnings")
    st.caption(
        "Earning = (blocks × (avgFees + avgTip) + inflationRewards) − (votes × 5000)"
    )

    # ---- Sidebar controls -------------------------------------------------
    with st.sidebar:
        st.header("Controls")
        csv_path_str = st.text_input("CSV path", value=str(DEFAULT_CSV_PATH))
        csv_path = Path(csv_path_str)

        if not csv_path.exists():
            st.error(f"CSV not found at: {csv_path}")
            st.stop()

        unit = st.radio("Units", options=["SOL", "lamports"], index=0, horizontal=True)
        log_x = st.checkbox("Log scale: stake (x)", value=True)
        log_y = st.checkbox("Log scale: earning (y)", value=False)
        agg = st.selectbox(
            "Client aggregation", options=["sum", "mean", "median"], index=0
        )

    df = load_data(csv_path)

    # ---- Client filter ----------------------------------------------------
    all_clients = sorted(df["client"].unique())
    with st.sidebar:
        selected_clients = st.multiselect(
            "Clients", options=all_clients, default=all_clients
        )

    df = df[df["client"].isin(selected_clients)]
    if df.empty:
        st.warning("No validators match the current filter.")
        st.stop()

    unit_label = "SOL" if unit == "SOL" else "lamports"

    # ---- Summary metrics --------------------------------------------------
    total_earning = to_unit(df["earning"], unit).sum()
    avg_earning = to_unit(df["earning"], unit).mean()

    col1, col2, col3, col4 = st.columns(4)
    col1.metric("Validators", f"{len(df):,}")
    col2.metric("Clients", f"{df['client'].nunique():,}")
    col3.metric(f"Total earning ({unit_label})", f"{total_earning:,.2f}")
    col4.metric(f"Avg earning ({unit_label})", f"{avg_earning:,.2f}")

    # ---- Chart 1: Stake vs Earning ---------------------------------------
    st.subheader("Stake vs. Earning")
    plot_df = df.copy()
    plot_df["stake_unit"] = to_unit(plot_df["stake"], unit)
    plot_df["earning_unit"] = to_unit(plot_df["earning"], unit)

    scatter = px.scatter(
        plot_df,
        x="stake_unit",
        y="earning_unit",
        color="client",
        hover_name="identity",
        hover_data={
            "client": True,
            "voteAccount": True,
            "blocks": ":,",
            "votes": ":,",
            "stake_unit": ":,.2f",
            "earning_unit": ":,.2f",
        },
        labels={
            "stake_unit": f"Stake ({unit_label})",
            "earning_unit": f"Earning ({unit_label})",
        },
        log_x=log_x,
        log_y=log_y,
        height=600,
    )
    scatter.update_traces(marker=dict(size=8, opacity=0.7))
    st.plotly_chart(scatter, use_container_width=True)

    # ---- Chart 2: Client vs Earning --------------------------------------
    st.subheader("Client vs. Earning")

    grouped = (
        df.groupby("client")["earning"]
        .agg(agg)
        .reset_index()
        .sort_values("earning", ascending=False)
    )
    grouped["earning"] = to_unit(grouped["earning"], unit)
    counts = df.groupby("client").size().rename("validators").reset_index()
    grouped = grouped.merge(counts, on="client")

    bar = px.bar(
        grouped,
        x="client",
        y="earning",
        color="client",
        hover_data={"validators": True, "earning": ":,.2f"},
        labels={"earning": f"{agg.capitalize()} earning ({unit_label})", "client": "Client"},
        height=500,
    )
    bar.update_layout(showlegend=False, xaxis={"categoryorder": "total descending"})
    st.plotly_chart(bar, use_container_width=True)

    with st.expander("Per-client earning distribution (box plot)"):
        box_df = df.copy()
        box_df["earning_unit"] = to_unit(box_df["earning"], unit)
        box = px.box(
            box_df,
            x="client",
            y="earning_unit",
            color="client",
            points="outliers",
            labels={"earning_unit": f"Earning ({unit_label})", "client": "Client"},
            height=500,
        )
        box.update_layout(showlegend=False, xaxis={"categoryorder": "median descending"})
        st.plotly_chart(box, use_container_width=True)

    # ---- Raw data ---------------------------------------------------------
    with st.expander("Show data table"):
        table = df.copy()
        table["stake"] = to_unit(table["stake"], unit)
        table["earning"] = to_unit(table["earning"], unit)
        st.dataframe(
            table[
                ["identity", "client", "stake", "blocks", "votes", "inflationRewards", "earning"]
            ].sort_values("earning", ascending=False),
            use_container_width=True,
        )


if __name__ == "__main__":
    main()
