// Lets the browser modules of the app run in Node: the one CDN import (hyparquet, only used for the old yearly layout) becomes a stub.
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
