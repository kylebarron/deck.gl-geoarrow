## Example: Use `@geoarrow/deck.gl-layers` with GeoArrow point data to render a Heatmap

## Data for example

```
wget https://ookla-open-data.s3.us-west-2.amazonaws.com/parquet/performance/type=mobile/year=2019/quarter=1/2019-01-01_performance_mobile_tiles.parquet
poetry install
poetry run python generate_data.py
```

## Serve data

```
npx http-server --cors
```

## Usage

To install dependencies:

```bash
npm install
# or
yarn
```

Commands:

* `npm start` is the development target, to serve the app and hot reload.
* `npm run build` is the production target, to create the final bundle and write to disk.
