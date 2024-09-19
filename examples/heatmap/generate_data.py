from pathlib import Path

import geopandas as gpd
import pandas as pd
import pyarrow as pa
import pyarrow.feather as feather
import shapely
from lonboard._geoarrow.geopandas_interop import geopandas_to_geoarrow
from lonboard.colormap import apply_continuous_cmap
from palettable.colorbrewer.diverging import BrBG_10

url = "https://ookla-open-data.s3.us-west-2.amazonaws.com/parquet/performance/type=mobile/year=2019/quarter=1/2019-01-01_performance_mobile_tiles.parquet"

path = Path("2019-01-01_performance_mobile_tiles.parquet")


def main():
    if not path.exists():
        msg = f"Please download file to this directory from {url=}."
        raise ValueError(msg)

    df = pd.read_parquet(path)
    centroids = shapely.centroid(shapely.from_wkt(df["tile"]))

    # Save space by using a smaller data type
    df_cols = ["avg_d_kbps", "avg_u_kbps", "avg_lat_ms"]
    for col in df_cols:
        df[col] = pd.to_numeric(df[col], downcast="unsigned")

    gdf = gpd.GeoDataFrame(df[df_cols], geometry=centroids)
    table = geopandas_to_geoarrow(gdf, preserve_index=False)

    min_bound = 5000
    max_bound = 50000
    download_speed = gdf["avg_d_kbps"]
    normalized_download_speed = (download_speed - min_bound) / (max_bound - min_bound)

    colors = apply_continuous_cmap(normalized_download_speed, BrBG_10)
    table = table.append_column(
        "colors", pa.FixedSizeListArray.from_arrays(colors.flatten("C"), 3)
    )

    feather.write_feather(
        table, "2019-01-01_performance_mobile_tiles.feather", compression="uncompressed"
    )


if __name__ == "__main__":
    main()
