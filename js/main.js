import { db } from './firebaseClient.js';
import { createSurveyApp } from './surveyRunner.js';

document.addEventListener('DOMContentLoaded', () => {
  const header = document.querySelector('header');

  const app = createSurveyApp({
    db,
    elements: {
      header,
      homeSection: document.getElementById('home'),
      listContainer: document.getElementById('surveyList'),
      runnerSection: document.getElementById('runner'),
      metaContainer: document.getElementById('meta'),
      bar: document.getElementById('bar'),
      questionContainer: document.getElementById('question'),
      optionsContainer: document.getElementById('options'),
      controlsContainer: document.getElementById('controls'),
      footnoteContainer: document.getElementById('footnote'),
      splashOverlay: document.getElementById('splashOverlay')
    }
  });

  app.init();
});
