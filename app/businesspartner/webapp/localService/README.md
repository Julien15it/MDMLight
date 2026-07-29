# Local mock service

The mock server (`ui5-mock.yaml`) needs an OData `metadata.xml` for the
`BusinessPartnerService`. Generate it from the CAP service instead of maintaining
it by hand, so it always matches the model:

```bash
# from the project root
cds compile srv/business-partner-service.cds \
  --service BusinessPartnerService \
  --to edmx-v4 \
  > app/businesspartner/webapp/localService/mainService/metadata.xml
```

Mock data (JSON) can then be dropped into
`mainService/data/` (one file per entity, e.g. `BusinessPartners.json`), or you
can let the mock server auto-generate it (`generateMockData: true`, already set).

For real data, just run the CAP backend (`cds watch` at the project root) and
start the app with `npm start` — it proxies `/service/businesspartner` to
`http://localhost:4004`.
