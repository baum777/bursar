// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Who owns an ERC-8004 agent on another chain, as last read there.
///
/// An endowment knows its agent through one call, `ownerOf(agentId)`, on the identity contract the
/// factory wires in. For an agent on Ethereum or Base that contract is this one: an id that encodes
/// the chain and the agent, and an owner the attestor copied from the home chain's registry. The
/// owner is an EVM address, so the same key accepts, draws and sets the mandate on Robinhood Chain.
///
/// The attestor can only say who the owner is. It cannot accept an endowment, draw from it or move
/// anything; those still need the owner's key. An id that was never attested reverts, as a registry
/// does for a token never minted, which is what keeps a factory from endowing a number.
contract RemoteIdentity {
    uint256 private constant AGENT_BITS = 160;
    uint256 private constant AGENT_MASK = (1 << AGENT_BITS) - 1;

    address public immutable attestor;

    mapping(uint256 => address) private _owners;
    /// Ids anyone asked the attestor to read, oldest first. The keeper walks this list; the
    /// attestor answers each one once and the list keeps growing, so a cursor is all it needs.
    uint256[] private _requests;
    mapping(uint256 => bool) public requested;

    event Attested(uint64 indexed chainId, uint256 indexed agentId, address indexed owner);
    event Requested(uint64 indexed chainId, uint256 indexed agentId, address indexed by);

    error NotAttestor();
    error ZeroAddress();
    error BadAgentId(uint256 agentId);
    error BadChainId(uint64 chainId);
    error Unknown(uint256 id);

    constructor(address attestor_) {
        if (attestor_ == address(0)) revert ZeroAddress();
        attestor = attestor_;
    }

    /// The id an endowment carries for `agentId` on `chainId`: the chain in the high bits, the agent
    /// in the low 160. No registry has minted anywhere near 2^160 agents, and no chain id is zero.
    function idOf(uint64 chainId, uint256 agentId) public pure returns (uint256) {
        if (chainId == 0) revert BadChainId(chainId);
        if (agentId > AGENT_MASK) revert BadAgentId(agentId);
        return (uint256(chainId) << AGENT_BITS) | agentId;
    }

    function chainOf(uint256 id) public pure returns (uint64) {
        return uint64(id >> AGENT_BITS);
    }

    function agentOf(uint256 id) public pure returns (uint256) {
        return id & AGENT_MASK;
    }

    /// Asks the attestor to read `agentId` on `chainId`: what a patron sends before endowing an agent
    /// nobody has endowed yet. One entry per id, however often it is asked.
    function request(uint64 chainId, uint256 agentId) external {
        uint256 id = idOf(chainId, agentId);
        if (!requested[id]) {
            requested[id] = true;
            _requests.push(id);
        }
        emit Requested(chainId, agentId, msg.sender);
    }

    function requestCount() external view returns (uint256) {
        return _requests.length;
    }

    /// Requests from `start`, at most `limit` of them, as encoded ids.
    function requestsFrom(uint256 start, uint256 limit) external view returns (uint256[] memory ids) {
        uint256 n = _requests.length;
        if (start >= n) return ids;
        uint256 end = start + limit;
        if (end > n) end = n;
        ids = new uint256[](end - start);
        for (uint256 i = start; i < end; ++i) {
            ids[i - start] = _requests[i];
        }
    }

    /// Records what the home chain's registry answers for `ownerOf(agentId)`. A zero owner records a
    /// burn, after which `ownerOf` reverts again.
    function attest(uint64 chainId, uint256 agentId, address owner) external {
        if (msg.sender != attestor) revert NotAttestor();
        _owners[idOf(chainId, agentId)] = owner;
        emit Attested(chainId, agentId, owner);
    }

    /// Several at once, for the keeper's sweep.
    function attestMany(uint64[] calldata chainIds, uint256[] calldata agentIds, address[] calldata owners) external {
        if (msg.sender != attestor) revert NotAttestor();
        uint256 n = chainIds.length;
        if (agentIds.length != n || owners.length != n) revert BadAgentId(n);
        for (uint256 i; i < n; ++i) {
            _owners[idOf(chainIds[i], agentIds[i])] = owners[i];
            emit Attested(chainIds[i], agentIds[i], owners[i]);
        }
    }

    /// The shape an endowment reads. Reverts for an id never attested, or attested as burned.
    function ownerOf(uint256 id) external view returns (address owner) {
        owner = _owners[id];
        if (owner == address(0)) revert Unknown(id);
    }

    function attested(uint64 chainId, uint256 agentId) external view returns (bool) {
        return _owners[idOf(chainId, agentId)] != address(0);
    }
}
