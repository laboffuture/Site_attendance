// Dashboard charts from window.__CHARTS__, rendered with ApexCharts — unified
// with the gauges + reports (one chart lib). No-ops if ApexCharts didn't load.
(function () {
  var c = window.__CHARTS__ || {};
  if (typeof ApexCharts === "undefined") return;
  var ACCENT = "#1c4d8c", GREY = "#cdd5df", AMBER = "#f5b438";
  var font = "Poppins, Inter, sans-serif";
  var PALETTE = ["#1c4d8c", "#21c06b", "#f5b438", "#2e97db", "#ff3b38", "#8e44ad", "#16a085", "#6F1E51"];
  function baseChart(type, height) { return { type: type, height: height, fontFamily: font, toolbar: { show: false }, redrawOnParentResize: true }; }
  function render(id, opts) { var el = document.getElementById(id); if (el) new ApexCharts(el, opts).render(); }
  var xlab = { rotate: -35, hideOverlappingLabels: true, style: { fontSize: "10px" } };
  var ylab = { style: { fontSize: "10px" } };

  // Attendance trend — area
  if (c.trend && c.trend.labels && c.trend.labels.length) {
    render("trendChart", {
      chart: baseChart("area", 240), colors: [ACCENT], dataLabels: { enabled: false },
      stroke: { curve: "smooth", width: 2 }, fill: { type: "gradient", gradient: { opacityFrom: 0.3, opacityTo: 0 } },
      series: [{ name: "Present", data: c.trend.data }],
      xaxis: { categories: c.trend.labels, labels: { hideOverlappingLabels: true, style: { fontSize: "10px" } } },
      yaxis: { labels: ylab },
    });
  }
  // OT hours by site — bar
  if (c.otBySite && c.otBySite.labels && c.otBySite.labels.length) {
    render("otChart", {
      chart: baseChart("bar", 240), colors: [AMBER], dataLabels: { enabled: false },
      plotOptions: { bar: { columnWidth: "55%" } },
      series: [{ name: "OT hours", data: c.otBySite.data }],
      xaxis: { categories: c.otBySite.labels, labels: xlab },
      yaxis: { labels: { formatter: function (v) { return v + "h"; }, style: { fontSize: "10px" } } },
    });
  }
  // Headcount by designation — bar (distributed palette)
  if (c.byDesignation && c.byDesignation.labels && c.byDesignation.labels.length) {
    render("desigChart", {
      chart: baseChart("bar", 240), colors: PALETTE, dataLabels: { enabled: false }, legend: { show: false },
      plotOptions: { bar: { columnWidth: "60%", distributed: true } },
      series: [{ name: "Workers", data: c.byDesignation.data }],
      xaxis: { categories: c.byDesignation.labels, labels: xlab },
      yaxis: { labels: ylab },
    });
  }
  // Present vs active per site — grouped bars
  if (c.presenceBySite && c.presenceBySite.labels && c.presenceBySite.labels.length) {
    render("presenceChart", {
      chart: baseChart("bar", 260), colors: [ACCENT, GREY], dataLabels: { enabled: false },
      plotOptions: { bar: { columnWidth: "60%" } },
      series: [{ name: "Present", data: c.presenceBySite.present }, { name: "Active", data: c.presenceBySite.active }],
      xaxis: { categories: c.presenceBySite.labels, labels: xlab },
      yaxis: { labels: ylab },
      legend: { position: "bottom", fontSize: "11px" },
    });
  }
})();
