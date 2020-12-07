import DIDService from "did.js";

( async() => {
	const didService = new DIDService();
	const did = await didService.create();
	console.log( did );
} )();