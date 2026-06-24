// Dashboard — the single OT-cost (₹) 14-day trend, rendered with ApexCharts.
// No-ops if ApexCharts didn't load.
(function () {
  var data = (window.__CHARTS__ && window.__CHARTS__.otTrend) || null;
  var el = document.getElementById("otTrendChart");
  if (!data || !el || typeof ApexCharts === "undefined") return;

  var accent = "#1c4d8c";
  var inr = function (v) { return "₹ " + Math.round(v || 0).toLocaleString("en-IN"); };

  new ApexCharts(el, {
    chart: { type: "area", height: 240, fontFamily: "Poppins, sans-serif", toolbar: { show: false } },
    series: [{ name: "OT cost", data: data.data }],
    xaxis: { categories: data.labels, labels: { style: { fontSize: "11px", colors: "#8a8f98" } }, axisBorder: { show: false }, axisTicks: { show: false }, tickAmount: 7 },
    yaxis: { labels: { style: { fontSize: "11px", colors: "#8a8f98" }, formatter: function (v) { return v >= 1000 ? "₹" + Math.round(v / 1000) + "k" : "₹" + Math.round(v); } } },
    colors: [accent],
    stroke: { curve: "straight", width: 2 },
    fill: { type: "gradient", gradient: { shadeIntensity: 0.1, opacityFrom: 0.25, opacityTo: 0.02 } },
    dataLabels: { enabled: false },
    grid: { borderColor: "#ececec", strokeDashArray: 3, padding: { left: 8, right: 8 } },
    tooltip: { y: { formatter: inr } },
    noData: { text: "No overtime in this period" },
  }).render();
})();
