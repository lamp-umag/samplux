// Old survey links look like  /samplux/?survey=<id>  — they now live at encuesta.html.
// Runs before the page paints, so participants never see the landing page.
(function () {
  if (new URLSearchParams(location.search).has('survey')) {
    location.replace('encuesta.html' + location.search + location.hash);
  }
})();
