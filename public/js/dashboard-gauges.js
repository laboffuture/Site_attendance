// Executive gauges — one ApexCharts radialBar per .oh-gauge element. The target
// percentage comes from data-value (+ optional data-unit). No-ops if ApexCharts
// didn't load. (Pattern ported from the executive-dashboard reference.)
(function () {
  if (typeof ApexCharts === "undefined") return;
  var ACCENT = "#1c4d8c";
  document.querySelectorAll(".oh-gauge").forEach(function (el) {
    var value = parseFloat(el.getAttribute("data-value")) || 0;
    var unit = el.getAttribute("data-unit") || "";
    var chart = new ApexCharts(el, {
      chart: { type: "radialBar", height: 200, fontFamily: "Poppins, Inter, sans-serif", redrawOnParentResize: true },
      series: [Math.max(0, Math.min(100, Math.round(value)))],
      colors: [ACCENT],
      plotOptions: {
        radialBar: {
          hollow: { size: "58%" },
          track: { background: "#e8ecf1" },
          dataLabels: {
            name: { show: false },
            value: { fontSize: "1.5rem", fontWeight: 600, offsetY: 6, formatter: function () { return value + unit; } },
          },
        },
      },
      labels: [""],
    });
    chart.render();
  });
})();
