// Reports-page visuals — ApexCharts from window.__REPORT_CHARTS__ (derived from
// the SAME filtered rows the tables + exports use). No-ops if ApexCharts didn't
// load. Added on top of the existing report tables; nothing removed.
(function () {
  if (typeof ApexCharts === "undefined" || !window.__REPORT_CHARTS__) return;
  var d = window.__REPORT_CHARTS__;
  var ACCENT = "#1c4d8c", AMBER = "#f5b438";
  var font = "Poppins, Inter, sans-serif";
  function render(id, opts) { var el = document.getElementById(id); if (el) new ApexCharts(el, opts).render(); }

  render("rpt-byday", {
    chart: { type: "area", height: 240, fontFamily: font, toolbar: { show: false }, redrawOnParentResize: true },
    dataLabels: { enabled: false }, colors: [ACCENT], stroke: { curve: "smooth", width: 2 },
    series: [{ name: "Records", data: d.byDay.data }],
    xaxis: { categories: d.byDay.labels, labels: { hideOverlappingLabels: true, style: { fontSize: "10px" } } },
    yaxis: { labels: { style: { fontSize: "10px" } } },
  });

  render("rpt-bysite", {
    chart: { type: "bar", height: 240, fontFamily: font, toolbar: { show: false }, redrawOnParentResize: true },
    dataLabels: { enabled: false }, colors: [ACCENT], plotOptions: { bar: { columnWidth: "55%" } },
    series: [{ name: "Records", data: d.bySite.count }],
    xaxis: { categories: d.bySite.labels, labels: { rotate: -35, hideOverlappingLabels: true, style: { fontSize: "10px" } } },
    yaxis: { labels: { style: { fontSize: "10px" } } },
  });

  render("rpt-otsite", {
    chart: { type: "bar", height: 240, fontFamily: font, toolbar: { show: false }, redrawOnParentResize: true },
    dataLabels: { enabled: false }, colors: [AMBER], plotOptions: { bar: { columnWidth: "55%" } },
    series: [{ name: "OT hours", data: d.bySite.ot }],
    xaxis: { categories: d.bySite.labels, labels: { rotate: -35, hideOverlappingLabels: true, style: { fontSize: "10px" } } },
    yaxis: { labels: { formatter: function (v) { return v + "h"; }, style: { fontSize: "10px" } } },
  });
})();
