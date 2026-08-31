(function () {
  "use strict";

  function showView(name) {
    ["loading", "setup", "auth", "onboarding", "sheet"].forEach(function (v) {
      var el = document.getElementById("view-" + v);
      if (el) el.hidden = v !== name;
    });
  }

  /* ============ tema ============ */
  var root = document.documentElement;
  var metaTheme = document.getElementById("meta-theme-color");
  function syncThemeColor() {
    if (!metaTheme) return;
    metaTheme.setAttribute("content", root.getAttribute("data-theme") === "dark" ? "#171435" : "#F7F7FA");
  }
  var stored = null;
  try { stored = localStorage.getItem("tema"); } catch (err) { stored = null; }
  if (stored === "dark" || stored === "light") {
    root.setAttribute("data-theme", stored);
  } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    root.setAttribute("data-theme", "dark");
  }
  syncThemeColor();
  document.getElementById("tema").addEventListener("click", function () {
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    syncThemeColor();
    try { localStorage.setItem("tema", next); } catch (err) {}
  });

  /* ============ liquid glass: brilho que segue o ponteiro ============ */
  document.addEventListener("pointermove", function (e) {
    var el = e.target.closest && e.target.closest(".glass");
    if (!el) return;
    var r = el.getBoundingClientRect();
    el.style.setProperty("--gx", ((e.clientX - r.left) / r.width * 100) + "%");
    el.style.setProperty("--gy", ((e.clientY - r.top) / r.height * 100) + "%");
  });

  /* ============ configuração do Supabase ============ */
  if (!window.DB.isConfigured) {
    showView("setup");
    return;
  }

  var db = window.DB.client;

  /* ============ roteamento por sessão ============ */
  function route(session) {
    if (!session) {
      document.getElementById("userbox").hidden = true;
      window.AuthView.reset();
      showView("auth");
      return;
    }

    var metaName = session.user.user_metadata && session.user.user_metadata.full_name;
    document.getElementById("userbox-email").textContent = metaName || session.user.email;
    document.getElementById("userbox").hidden = false;

    db.from("profiles").select("*").eq("id", session.user.id).single().then(function (res) {
      var profile = res.data;
      if (!metaName && profile && profile.full_name) {
        document.getElementById("userbox-email").textContent = profile.full_name;
      }
      if (!profile || !profile.onboarding_completed) {
        showView("onboarding");
        window.OnboardingView.show(session.user, profile, function () { route(session); });
        return;
      }
      showView("sheet");
      window.SheetView.show(session.user, profile);
    });
  }

  db.auth.onAuthStateChange(function (event, session) {
    if (event === "PASSWORD_RECOVERY") {
      showView("auth");
      window.AuthView.showRecovery();
      return;
    }
    route(session);
  });

  document.getElementById("btn-logout").addEventListener("click", function () {
    db.auth.signOut();
  });

  window.App = {
    refresh: function () { db.auth.getSession().then(function (res) { route(res.data.session); }); }
  };

  window.AuthView.mount();
  window.OnboardingView.mount();
  window.SheetView.mount();

  showView("loading");
  db.auth.getSession().then(function (res) { route(res.data.session); });
})();
