import type { FastifyInstance } from "fastify";
import { authenticate, requireOrgMember, requireRole } from "../middleware/auth.js";
import { query } from "../db/client.js";
import { audit } from "../services/audit.service.js";
import { listCrossDomainFindings, listRemediationProposals } from "../services/cross-domain.service.js";

const member = [authenticate, requireOrgMember];
const approver = [authenticate, requireOrgMember, requireRole("owner", "admin")];

export async function crossDomainRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/:scanId/cross-domain", { preHandler: member }, async (request, reply) => {
    const { scanId } = request.params as { scanId: string };
    const { rows } = await query("SELECT id FROM scans WHERE id=$1 AND org_id=$2", [scanId, request.orgId]);
    if (!rows[0]) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Scan not found" } });
    return reply.send({ data: await listCrossDomainFindings(scanId, request.orgId) });
  });

  fastify.get("/:scanId/remediation", { preHandler: member }, async (request, reply) => {
    const { scanId } = request.params as { scanId: string };
    const { rows } = await query("SELECT id FROM scans WHERE id=$1 AND org_id=$2", [scanId, request.orgId]);
    if (!rows[0]) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Scan not found" } });
    return reply.send({ data: await listRemediationProposals(scanId, request.orgId) });
  });

  fastify.post("/remediation/:proposalId/approve", { preHandler: approver }, async (request, reply) => {
    const { proposalId } = request.params as { proposalId: string };
    const { rows } = await query<{ id: string }>("UPDATE remediation_proposals SET approval_status='APPROVED', approved_by=$3, approved_at=NOW(), updated_at=NOW() WHERE id=$1 AND org_id=$2 AND approval_status='PROPOSED' AND requires_human_approval=TRUE RETURNING id", [proposalId, request.orgId, request.authUser.id]);
    if (!rows[0]) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Proposal not found or already decided" } });
    await audit({ orgId: request.orgId, userId: request.authUser.id, action: "remediation.approve", resourceType: "remediation_proposal", resourceId: proposalId, result: "success" });
    return reply.send({ data: { id: proposalId, approvalStatus: "APPROVED" } });
  });

  fastify.post("/remediation/:proposalId/reject", { preHandler: approver }, async (request, reply) => {
    const { proposalId } = request.params as { proposalId: string };
    const { rows } = await query<{ id: string }>("UPDATE remediation_proposals SET approval_status='REJECTED', updated_at=NOW() WHERE id=$1 AND org_id=$2 AND approval_status='PROPOSED' AND requires_human_approval=TRUE RETURNING id", [proposalId, request.orgId]);
    if (!rows[0]) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Proposal not found or already decided" } });
    await audit({ orgId: request.orgId, userId: request.authUser.id, action: "remediation.reject", resourceType: "remediation_proposal", resourceId: proposalId, result: "success" });
    return reply.send({ data: { id: proposalId, approvalStatus: "REJECTED" } });
  });
}
