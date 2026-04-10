<script>
    import mapboxgl from "mapbox-gl";
    import "../../node_modules/mapbox-gl/dist/mapbox-gl.css";
    import { onMount } from "svelte";
    import * as d3 from 'd3';

    let map;
    async function initMap() {
        map = new mapboxgl.Map({
            container: 'map',
            center: [-71.09415, 42.36027],
            zoom: 12,
            style: "mapbox://styles/mapbox/streets-v12",
        });
        await new Promise(resolve => map.on("load", resolve));

        // Boston bike lanes
        map.addSource("boston_route", {
            type: "geojson",
            data: "https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson?outSR=%7B%22latestWkid%22%3A3857%2C%22wkid%22%3A102100%7D",
        });
        map.addLayer({
            id: "boston_bike_lanes", // A name for our layer
            type: "line", // one of the supported layer types, e.g. line, circle, etc.
            source: "boston_route", // The id we specified in `addSource()`
            paint: {
                "line-color": "green",
                "line-width": 3,
                "line-opacity": 0.4
            }
        });

        // Cambridge bike lanes
        map.addSource("cambridge_route", {
            type: "geojson",
            data: "https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson"
        });
        map.addLayer({
            id: "cambridge_bike_lanes",
            type: "line",
            source: "cambridge_route",
            paint: {
                "line-color": "green",
                "line-width": 3,
                "line-opacity": 0.4
            }
        });
    }

    let mapViewChanged = 0;
    let stations = [];
    let trips = [];
    let departures = new Map();
    let arrivals = new Map();
    const departuresByMinute = Array.from({length: 1440}, () => []);
    const arrivalsByMinute = Array.from({length: 1440}, () => []);
    $: map?.on("move", evt => mapViewChanged++);
    async function loadData() {
        stations = await d3.csv("https://vis-society.github.io/labs/9/data/bluebikes-stations.csv");
        trips = await d3.csv("https://vis-society.github.io/labs/9/data/bluebikes-traffic-2024-03.csv").then(trips => {
            for (let trip of trips) {
                trip.started_at = new Date(trip.started_at);
                trip.ended_at = new Date(trip.ended_at);
                let startedMinutes = minutesSinceMidnight(trip.started_at);
                departuresByMinute[startedMinutes].push(trip);
                let endedMinutes = minutesSinceMidnight(trip.ended_at);
                arrivalsByMinute[endedMinutes].push(trip);
            }
            return trips;
        });
    }
    function getCoords (station) {
        let point = new mapboxgl.LngLat(+station.Long, +station.Lat);
        let {x, y} = map.project(point);
        return {cx: x, cy: y};
    }
    onMount(async () => {
        mapboxgl.accessToken = "pk.eyJ1IjoieW95b3l1YW4iLCJhIjoiY21udDllamhnMG05MzJyb2R5aWc5dnBseSJ9.vGsvK4kAnD-1KWTS3rYNDg";
        await Promise.all([initMap(), loadData()]);
        departures = d3.rollup(trips, v => v.length, d => d.start_station_id);
        arrivals = d3.rollup(trips, v => v.length, d => d.end_station_id);
        stations = stations.map(station => {
            let id = station.Number;
            station.arrivals = arrivals.get(id) ?? 0;
            station.departures = departures.get(id) ?? 0;
            station.totalTraffic = station.arrivals + station.departures;
            return station;
        });
    });
    $: radiusScale = d3.scaleSqrt()
        .domain([0, d3.max(stations, d => d.totalTraffic) || 0])
        .range(timeFilter === -1 ? [0, 25] : [3, 40]);

    // Data filtering by time
    let timeFilter = -1;
    $: timeFilterLabel = new Date(0, 0, 0, 0, timeFilter)
                         .toLocaleString("en", {timeStyle: "short"});
    function minutesSinceMidnight (date) {
        return date.getHours() * 60 + date.getMinutes();
    }
    function filterByMinute (tripsByMinute, minute) {
        let minMinute = (minute - 60 + 1440) % 1440;
        let maxMinute = (minute + 60) % 1440;
        if (minMinute > maxMinute) {
            let beforeMidnight = tripsByMinute.slice(minMinute);
            let afterMidnight = tripsByMinute.slice(0, maxMinute);
            return beforeMidnight.concat(afterMidnight).flat();
        }
        else {
            return tripsByMinute.slice(minMinute, maxMinute).flat();
        }
    }
    $: filteredDepartures = timeFilter === -1 ? departures
        : d3.rollup(filterByMinute(departuresByMinute, timeFilter), v => v.length, d => d.start_station_id);
    $: filteredArrivals = timeFilter === -1 ? arrivals
        : d3.rollup(filterByMinute(arrivalsByMinute, timeFilter), v => v.length, d => d.end_station_id);
    $: filteredStations = stations.map(station => {
        const id = station.Number;
        const arr = filteredArrivals.get(id) ?? 0;
        const dep = filteredDepartures.get(id) ?? 0;
        return {
            ...station,
            arrivals: arr,
            departures: dep,
            totalTraffic: arr + dep
        };
    });

    // Traffic flow coloring
    let stationFlow = d3.scaleQuantize()
        .domain([0, 1])
        .range([0, 0.5, 1]);

    // Isochrones
    const urlBase = 'https://api.mapbox.com/isochrone/v1/mapbox/';
    const profile = 'cycling';
    const minutes = [5, 10, 15, 20];
    const contourColors = [
        "03045e",
        "0077b6",
        "00b4d8",
        "90e0ef"
    ]
    let isochrone = null;
    let selectedStation = null;
    async function getIso(lon, lat) {
        const base = `${urlBase}${profile}/${lon},${lat}`;
        const params = new URLSearchParams({
            contours_minutes: minutes.join(','),
            contours_colors: contourColors.join(','),
            polygons: 'true',
            access_token: mapboxgl.accessToken
        });
        const url = `${base}?${params.toString()}`;

        const query = await fetch(url, { method: 'GET' });
        isochrone = await query.json();
    }
    function geoJSONPolygonToPath(feature) {
        const path = d3.path();
        const rings = feature.geometry.coordinates;
        for (const ring of rings) {
            for (let i = 0; i < ring.length; i++) {
                const [lng, lat] = ring[i];
                const { x, y } = map.project([lng, lat]);
                if (i === 0) path.moveTo(x, y);
                else path.lineTo(x, y);
            }
            path.closePath();
        }
        return path.toString();
    }
    $: if (selectedStation) {
        getIso(+selectedStation.Long, +selectedStation.Lat);
    } else {
        isochrone = null;
    }
</script>

<header>
    <h1>🚴‍♀️ BikeWatch</h1>
    <label>
        Filter by time:
        <input type="range" min="-1" max="1440" bind:value={timeFilter}/>
        {#if timeFilter !== -1}
            <time style="display: block">
                {timeFilterLabel}
            </time>
        {:else}
            <em style="display: block">(any time)</em>
        {/if}
    </label>
</header>
<div id="map">
    <svg>
        {#key mapViewChanged}
            {#if isochrone}
                {#each isochrone.features as feature}
                    <path
                            d={geoJSONPolygonToPath(feature)}
                            fill={feature.properties.fillColor}
                            fill-opacity="0.2"
                            stroke="#000000"
                            stroke-opacity="0.5"
                            stroke-width="1"
                    >
                        <title>{feature.properties.contour} minutes of biking</title>
                    </path>
                {/each}
            {/if}
            {#each filteredStations as station}
                <circle { ...getCoords(station) }
                    r={radiusScale(station.totalTraffic)}
                    style="--departure-ratio: {station.totalTraffic ? stationFlow(station.departures / station.totalTraffic) : 0.5}"
                    class={station?.Number === selectedStation?.Number ? "selected" : ""}
                    on:mousedown={() => selectedStation = selectedStation?.Number !== station?.Number ? station : null}
                >
                    <title>{station.totalTraffic} trips ({station.departures} departures, { station.arrivals} arrivals)</title>
                </circle>
            {/each}
        {/key}
    </svg>
</div>
<div class="legend">
    <span class="legend-title">Legend:</span>
    <div style="--departure-ratio: 1">More departures</div>
    <div style="--departure-ratio: 0.5">Balanced</div>
    <div style="--departure-ratio: 0">More arrivals</div>
</div>

<style>
    @import url("$lib/global.css");

    #map {
        flex: 1;
        position: relative;
    }

    #map svg {
        position: absolute;
        z-index: 1;
        width: 100%;
        height: 100%;
        pointer-events: none;
    }

    #map svg circle {
        --color-departures: steelblue;
        --color-arrivals: darkorange;
        --color: color-mix(
            in oklch,
            var(--color-departures) calc(100% * var(--departure-ratio)),
            var(--color-arrivals)
        );
        fill: var(--color);
        fill-opacity: 60%;
        stroke: white;
        pointer-events: auto;
        transition: opacity 0.2s ease;
    }

    /* Dims other circles when one is selected */
    #map svg:has(circle.selected) circle:not(.selected) {
        opacity: 0.3;
    }

    #map svg path {
        pointer-events: auto;
    }

    .legend {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 1.5rem;
        margin-block: 1rem;
        font-size: 0.95rem;
    }

    .legend-title {
        text-transform: uppercase;
        color: gray;
    }

    .legend div {
        --color-departures: steelblue;
        --color-arrivals: darkorange;
        --color: color-mix(
            in oklch,
            var(--color-departures) calc(100% * var(--departure-ratio)),
            var(--color-arrivals)
        );

        display: flex;
        align-items: center;
        gap: 0.45rem;
    }

    .legend div::before {
        content: "";
        width: 1rem;
        height: 1rem;
        border-radius: 50%;
        background-color: var(--color);
        flex-shrink: 0;
    }

    header {
        display: flex;
        gap: 1em;
        align-items: baseline;
    }

    label {
        margin-left: auto;
        display: grid;
        grid-template-columns: auto 1fr;
        flex-direction: column;
        column-gap: 0.25em;
    }

    label input {
        width: 20em;
    }

    input, time, em {
        grid-column: 2;
    }

    time, em {
        display: block;
        text-align: right;
    }

    em {
        color: gray;
        font-style: italic;
    }
</style>
