import js from '@eslint/js';
import globals from 'globals';

const railwayGlobals = Object.fromEntries(
  [
    'chrome',
    'importScripts',
    'RailWatchUI',
    'RailWatchBooking',
    'RailWatchWatch',
    'RailWatchCalendar',
    'RailWatchScanner',
    'RailWatchAlerts',
    'sessionDataBooking',
    'departureTrips',
    'arrivalTrips',
    'chooseTrip',
    'departureTrainCoachs',
    'arrivalTrainCoachs',
    'divTrainCoach',
    'step',
    'removeDataByUserId',
    'IsGenderRoomSeat',
    'ladyRoomItems',
    'bothMenAndLadyItems',
    'menRoomItems',
    'monkRoomItems',
    'clearDataMember',
    'setDataMember',
    'RecaptchaHelper',
    'TurnstileHelper',
    'handleNextButtonClicked',
    'jQuery',
    'SmartUtil',
  ].map((name) => [name, 'readonly']),
);

export default [
  {
    ignores: [
      'extension/content.js',
      'extension/ui.js',
      'extension/preview-data.js',
      '.venv/**',
      '.audit/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['extension/*.js', 'scan-availability.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...railwayGlobals, module: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['tests/**/*.cjs', 'scripts/*.cjs'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['scan-availability.js'],
    rules: {
      'no-unused-vars': [
        'error',
        { varsIgnorePattern: '^scanAvailability$', caughtErrors: 'none' },
      ],
    },
  },
  { files: ['*.mjs'], languageOptions: { globals: globals.node } },
];
