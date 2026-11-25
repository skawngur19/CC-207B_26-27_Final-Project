import { createRelay } from './hosting-relay.mjs';
const server=createRelay({upstream:process.env.CLINCH_UPSTREAM_ORIGIN,relaySecret:process.env.CLINCH_RELAY_SECRET});
server.requestTimeout=15000;
server.headersTimeout=10000;
server.listen(Number(process.env.PORT??8080),'0.0.0.0');
