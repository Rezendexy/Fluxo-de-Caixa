(function (global) {
  "use strict";

  var shortMoney = Format.shortMoney;
  var esc = Format.esc;

  var CW = 720, CH = 220, PAD = { t: 16, r: 10, b: 26, l: 54 };

  /**
   * cfg = {
   *   labels: [string...],       // rótulo curto por ponto (mês)
   *   values: [number...],       // saldo acumulado por ponto
   *   tooltip: function(index) -> html
   * }
   */
  function draw(host, cfg) {
    if (!cfg || !cfg.values.length) {
      host.innerHTML = '<div style="height:120px;display:grid;place-items:center;color:var(--muted);font-size:13px">O gráfico aparece assim que houver dados de pelo menos um mês.</div>';
      return;
    }

    var values = cfg.values;
    var n = values.length - 1;
    var max = Math.max.apply(null, values.concat([0]));
    var min = Math.min.apply(null, values.concat([0]));
    var span = (max - min) || 1;
    max = max + span * 0.15;
    min = min - span * 0.15;
    span = max - min;

    var iw = CW - PAD.l - PAD.r, ih = CH - PAD.t - PAD.b;
    var X = function (k) { return PAD.l + (n === 0 ? iw / 2 : (k / n) * iw); };
    var Y = function (v) { return PAD.t + ih - ((v - min) / span) * ih; };

    var uid = (host.id || "chart") + "-" + Math.random().toString(36).slice(2, 7);
    var gradId = "g-" + uid;
    var negative = values[n] < 0;
    var lineColor = negative ? "var(--warm)" : "var(--accent)";

    var svg = '<svg viewBox="0 0 ' + CW + ' ' + CH + '" role="img" aria-label="Evolução do saldo acumulado" preserveAspectRatio="xMidYMid meet">';
    svg += '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + lineColor + '" stop-opacity=".26"/>' +
      '<stop offset="100%" stop-color="' + lineColor + '" stop-opacity="0"/>' +
      '</linearGradient></defs>';

    // linha de zero + grades
    for (var g = 0; g <= 2; g++) {
      var val = min + (span / 2) * g, y = Y(val);
      var isZero = min < 0 && max > 0 && Math.abs(val) < span * 0.02;
      svg += '<line x1="' + PAD.l + '" y1="' + y.toFixed(1) + '" x2="' + (CW - PAD.r) + '" y2="' + y.toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>';
      svg += '<text x="' + (PAD.l - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" font-weight="500" fill="var(--muted)">' + esc(shortMoney(val)) + '</text>';
    }
    if (min < 0 && max > 0) {
      var yz = Y(0);
      svg += '<line x1="' + PAD.l + '" y1="' + yz.toFixed(1) + '" x2="' + (CW - PAD.r) + '" y2="' + yz.toFixed(1) + '" stroke="var(--line-strong)" stroke-width="1.3"/>';
    }

    // rótulos do eixo x (poucos, para não poluir)
    var step = Math.max(1, Math.ceil((n + 1) / 6));
    for (var k = 0; k <= n; k += step) {
      svg += '<text x="' + X(k).toFixed(1) + '" y="' + (CH - 8) + '" text-anchor="middle" fill="var(--muted)">' + esc(cfg.labels[k]) + '</text>';
    }

    function path(vals, close) {
      var d = "";
      for (var i = 0; i < vals.length; i++) d += (i ? "L" : "M") + X(i).toFixed(2) + " " + Y(vals[i]).toFixed(2) + " ";
      if (close) d += "L" + X(vals.length - 1).toFixed(2) + " " + Y(min).toFixed(2) + " L" + X(0).toFixed(2) + " " + Y(min).toFixed(2) + " Z";
      return d.trim();
    }

    svg += '<path d="' + path(values, true) + '" fill="url(#' + gradId + ')"/>';
    svg += '<path d="' + path(values, false) + '" fill="none" stroke="' + lineColor + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
    svg += '<circle cx="' + X(n).toFixed(2) + '" cy="' + Y(values[n]).toFixed(2) + '" r="5" fill="' + lineColor + '" stroke="var(--surface)" stroke-width="2"/>';

    svg += '<line class="js-guide" x1="0" y1="' + PAD.t + '" x2="0" y2="' + (PAD.t + ih) + '" stroke="var(--line-strong)" stroke-width="1.5" opacity="0"/>';
    svg += '<circle class="js-dot" r="5" fill="var(--ink)" stroke="var(--surface)" stroke-width="2" opacity="0"/>';
    svg += '<rect class="js-hit" x="' + PAD.l + '" y="' + PAD.t + '" width="' + iw + '" height="' + ih + '" fill="transparent"/>';
    svg += "</svg>";

    host.innerHTML = svg + '<div class="tip"></div>';
    if (typeof cfg.tooltip !== "function") return;

    var svgEl = host.querySelector("svg");
    var guide = host.querySelector(".js-guide");
    var dot = host.querySelector(".js-dot");
    var tip = host.querySelector(".tip");

    function move(ev) {
      var r = svgEl.getBoundingClientRect();
      if (!r.width) return;
      var px = (ev.clientX - r.left) * (CW / r.width);
      var k = Math.round(((px - PAD.l) / iw) * n);
      if (k < 0) k = 0; if (k > n) k = n;
      guide.setAttribute("x1", X(k).toFixed(2));
      guide.setAttribute("x2", X(k).toFixed(2));
      guide.setAttribute("opacity", "1");
      dot.setAttribute("cx", X(k).toFixed(2));
      dot.setAttribute("cy", Y(values[k]).toFixed(2));
      dot.setAttribute("opacity", "1");
      tip.innerHTML = cfg.tooltip(k);
      tip.classList.add("is-on");
      var hr = host.getBoundingClientRect();
      var dx = r.left - hr.left, dy = r.top - hr.top;
      var left = (X(k) / CW) * r.width + dx;
      var top = (Y(values[k]) / CH) * r.height + dy - 12;
      tip.style.left = Math.max(80, Math.min(hr.width - 80, left)) + "px";
      tip.style.top = Math.max(56, top) + "px";
    }
    function leave() { guide.setAttribute("opacity", "0"); dot.setAttribute("opacity", "0"); tip.classList.remove("is-on"); }

    svgEl.addEventListener("mousemove", move);
    svgEl.addEventListener("mouseleave", leave);
    svgEl.addEventListener("touchstart", function (e) { if (e.touches[0]) move(e.touches[0]); }, { passive: true });
    svgEl.addEventListener("touchmove", function (e) { if (e.touches[0]) move(e.touches[0]); }, { passive: true });
    svgEl.addEventListener("touchend", leave);
  }

  global.SheetChart = { draw: draw };
})(window);
