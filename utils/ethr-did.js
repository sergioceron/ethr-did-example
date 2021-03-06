import HttpProvider from 'ethjs-provider-http'
import Eth from 'ethjs-query'
import EthContract from 'ethjs-contract'
import DidRegistryContract from './ethr-did-registry.js'
import { Buffer } from 'buffer'
import edr from 'ethr-did-resolver'
import jwt from 'did-jwt'
import elliptic from "elliptic";
import ethutils from "ethereumjs-util";
import sha3 from "js-sha3";
import ethTx from "ethereumjs-tx";

const secp256k1 = new elliptic.ec( 'secp256k1' )
const { Secp256k1VerificationKey2018 } = edr.delegateTypes

function toEthereumAddress( hexPublicKey ) {
	return `0x${ethutils.keccak( Buffer.from( hexPublicKey.slice( 2 ), 'hex' ) )
		.slice( -20 )
		.toString( 'hex' )}`
}

function configureProvider( conf = {} ) {
	if( conf.provider ) {
		return conf.provider
	}
	if( conf.web3 ) {
		return conf.web3.currentProvider
	}
	return new HttpProvider( conf.rpcUrl || 'https://mainnet.infura.io/ethr-did' )
}

function getTxData( web3, owner ) {
	const functionName = "changeOwner"
	const typeOfData = "address,address"
	let set = web3.eth.abi.encodeFunctionSignature( `${functionName}(${typeOfData})` )
	let value = web3.eth.abi.encodeParameters( ["address", "address"], [owner, owner] )
	const txData = set + value.substr( 2 )
	return txData;
}

function stripHexPrefix( str ) {
	if( str.startsWith( "0x" ) ) {
		return str.slice( 2 );
	}
	return str;
}

function leftPad( data, size = 64 ) {
	if( data.length === size ) return data;
	return "0".repeat( size - data.length ) + data;
}

async function signData( identity, signer, key, data, didReg ) {
	const nonce = await didReg.nonce( signer );
	const paddedNonce = leftPad( Buffer.from( [nonce], 64 ).toString( "hex" ) );
	const dataToSign =
		`1900${stripHexPrefix( didReg.address )}${paddedNonce}${stripHexPrefix( identity )}${data}`;
	const hash = Buffer.from( sha3.buffer( Buffer.from( dataToSign, "hex" ) ) );
	const signature = ethutils.ecsign( hash, Buffer.from( key, 'hex' ) );
	return {
		r: `0x${signature.r.toString( "hex" )}`,
		s: `0x${signature.s.toString( "hex" )}`,
		v: signature.v
	};
}

function attributeToHex( key, value ) {
	if( Buffer.isBuffer( value ) ) {
		return `0x${value.toString( 'hex' )}`
	}
	const match = key.match( /^did\/(pub|auth|svc)\/(\w+)(\/(\w+))?(\/(\w+))?$/ )
	if( match ) {
		const encoding = match[6]
		// TODO add support for base58
		if( encoding === 'base64' ) {
			return `0x${Buffer.from( value, 'base64' ).toString( 'hex' )}`
		}
	}
	if( value.match( /^0x[0-9a-fA-F]*$/ ) ) {
		return value
	}
	return `0x${Buffer.from( value ).toString( 'hex' )}`
}

export default class EthrDid {
	constructor( conf = {} ) {
		const provider = configureProvider( conf )
		const eth = new Eth( provider )
		const registryAddress = conf.registry || edr.REGISTRY
		const DidReg = new EthContract( eth )( DidRegistryContract )
		this.registry = DidReg.at( registryAddress )
		this.address = conf.address
		this.registryAddress = conf.registry;
		if( !this.address ) throw new Error( 'No address is set for EthrDid' )
		this.did = `did:ethr:lacchain:${this.address}`
		if( conf.signer ) {
			this.signer = conf.signer
		} else if( conf.privateKey ) {
			this.signer = jwt.SimpleSigner( conf.privateKey )
		}
		this.privateKey = conf.privateKey;
		this.provider = provider;
		this.web3 = conf.web3;
		this.contract = new conf.web3.eth.Contract( DidRegistryContract, registryAddress );
	}

	static createKeyPair() {
		const kp = secp256k1.genKeyPair()
		const publicKey = kp.getPublic( 'hex' )
		const privateKey = kp.getPrivate( 'hex' )
		const address = toEthereumAddress( publicKey )
		return { address, publicKey, privateKey }
	}

	async lookupOwner( cache = true ) {
		if( cache && this.owner ) return this.owner
		const result = await this.registry.identityOwner( this.address )
		return result['0']
	}

	async changeOwnerSigned( signerAddress, privateKey, newOwner ) {
		const sig = await signData(
			signerAddress,
			signerAddress,
			privateKey,
			Buffer.from( "changeOwner" ).toString( "hex" ) +
			stripHexPrefix( newOwner ),
			this.registry
		);
		const tx = await this.registry.changeOwnerSigned(
			signerAddress,
			sig.v,
			sig.r,
			sig.s,
			newOwner,
			{
				from: newOwner,
				gasLimit: 0,
				gasPrice: 0
			}
		);
		this.owner = newOwner;
		return tx;
	}

	async changeOwner( newOwner ) {
		const owner = await this.lookupOwner()
		const txHash = await this.registry.changeOwner( this.address, newOwner, {
			from: owner,
			gasLimit: 0,
			gasPrice: 0
		} )
		this.owner = newOwner
		return txHash
	}

	async addDelegate( delegate, options = {} ) {
		const delegateType = options.delegateType || Secp256k1VerificationKey2018
		const expiresIn = options.expiresIn || 86400
		const owner = await this.lookupOwner()
		return this.registry.addDelegate(
			this.address,
			delegateType,
			delegate,
			expiresIn,
			{ from: owner, gasPrice: 0 }
		)
	}

	async revokeDelegate( delegate, delegateType = Secp256k1VerificationKey2018 ) {
		const owner = await this.lookupOwner()
		return this.registry.revokeDelegate( this.address, delegateType, delegate, {
			from: owner
		} )
	}

	async setAttribute( key, value, expiresIn = 31536000 ) {
		const owner = await this.lookupOwner();
		const data = this.contract.methods.setAttribute( owner,
			edr.stringToBytes32( key ),
			attributeToHex( key, value ),
			expiresIn
		);
		const txCount = await this.web3.eth.getTransactionCount( owner )
		const transaction = new ethTx( {
			nonce: this.web3.utils.toHex( txCount ),
			gasLimit: this.web3.utils.toHex( 284908 ),
			gasPrice: this.web3.utils.toHex( 0 ),
			to: this.registryAddress,
			data: data.encodeABI()
		} )
		transaction.sign( Buffer.from( this.privateKey, 'hex' ) )
		const serializedTx = transaction.serialize().toString( 'hex' )
		return await this.web3.eth.sendSignedTransaction( '0x' + serializedTx )
	}

	async revokeAttribute( key, value, gasLimit ) {
		const owner = await this.lookupOwner()
		return this.registry.revokeAttribute(
			this.address,
			stringToBytes32( key ),
			attributeToHex( key, value ),
			{
				from: owner,
				gas: gasLimit
			}
		)
	}

	// Create a temporary signing delegate able to sign JWT on behalf of identity
	async createSigningDelegate(
		delegateType = Secp256k1VerificationKey2018,
		expiresIn = 86400
	) {
		const kp = EthrDid.createKeyPair()
		this.signer = jwt.SimpleSigner( kp.privateKey )
		const txHash = await this.addDelegate( kp.address, {
			delegateType,
			expiresIn
		} )
		return { kp, txHash }
	}

	async signJWT( payload, expiresIn ) {
		if( typeof this.signer !== 'function' ) {
			throw new Error( 'No signer configured' )
		}
		const options = { signer: this.signer, alg: 'ES256K-R', issuer: this.did }
		if( expiresIn ) options.expiresIn = expiresIn
		return jwt.createJWT( payload, options )
	}

	async verifyJWT( jwt, resolver, audience = this.did ) {
		return jwt.verifyJWT( jwt, { resolver, audience } )
	}
}
