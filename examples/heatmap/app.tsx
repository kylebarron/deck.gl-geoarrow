import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { StaticMap, MapContext, NavigationControl } from "react-map-gl";
import DeckGL, { Layer, PickingInfo } from "deck.gl";
import { GeoArrowHeatmapLayer } from "@geoarrow/deck.gl-layers";
import * as arrow from "apache-arrow";

const GEOARROW_POINT_DATA =
  "http://localhost:8080/2019-01-01_performance_mobile_tiles.feather";

const INITIAL_VIEW_STATE = {
  latitude: 20,
  longitude: 0,
  zoom: 2,
  bearing: 0,
  pitch: 0,
};

const MAP_STYLE =
  "https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json";
const NAV_CONTROL_STYLE = {
  position: "absolute",
  top: 10,
  left: 10,
};

function Root() {
  const onClick = (info: PickingInfo) => {
    if (info.object) {
      console.log(JSON.stringify(info.object.toJSON()));
    }
  };

  const [table, setTable] = useState<arrow.Table | null>(null);

  useEffect(() => {
    // declare the data fetching function
    const fetchData = async () => {
      const data = await fetch(GEOARROW_POINT_DATA);
      const buffer = await data.arrayBuffer();
      const table = arrow.tableFromIPC(buffer);
      setTable(table);
    };

    if (!table) {
      fetchData().catch(console.error);
    }
  });

  const layers: Layer[] = [];

  // Scenario 1: Just pass the table to the layer, with no additional properties. As the layer is a GeoArrowLayer, it should automatically detect the columns that are needed for the visualization.
  // table &&
  //   layers.push(
  //     new GeoArrowHeatmapLayer({
  //       id: "geoarrow-heatmap",
  //       data: table,
  //     }),
  //   );

  // Scenario 2: pass a getWeight function returning a random number, which
  // avoids the error in the construction, but do not render anything.
  table &&
    layers.push(
      new GeoArrowHeatmapLayer({
        id: "geoarrow-heatmap",
        data: table,
        getWeight: (d: any) => Math.random() * 100 + 1,
      }),
    );

  return (
    <DeckGL
      initialViewState={INITIAL_VIEW_STATE}
      controller={true}
      layers={layers}
      ContextProvider={MapContext.Provider}
      onClick={onClick}
    >
      <StaticMap mapStyle={MAP_STYLE} />
      <NavigationControl style={NAV_CONTROL_STYLE} />
    </DeckGL>
  );
}

/* global document */
const container = document.body.appendChild(document.createElement("div"));
createRoot(container).render(<Root />);
