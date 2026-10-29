.PHONY: install dev

install:
	npm install
	cd gateway && npm install
	cd dashboard && npm install

dev:
	npm run dev
